const publishJSONMock = jest.fn()

const topicMock = jest.fn().mockImplementation(() => {
  return {
    publishJSON: publishJSONMock,
  }
})

const PubSubMock = jest.fn().mockImplementation(() => {
  return {
    topic: topicMock,
  }
})

jest.mock('@google-cloud/pubsub', () => ({
  PubSub: PubSubMock,
}))

//////////////////////////////////////////////////////////////
// DO NOT MOVE THIS import CALL ABOVE jest MOCKS
// import PubSub after we've mocked @google-cloud/pubsub
import {
  PubSub,
  UnprocessedPubSubMessage,
  InMemoryStateManager,
  EventStatus,
  SubscriptionError,
  HandlerResult,
} from '../src'

import { JSON } from '../src/json'

const sleepMs = (ms: number) =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, ms)
  })

const getDate = (date?: Date): Date => {
  if (date) {
    return date
  } else {
    throw new Error('Missing Date')
  }
}

const base64Encode = <T extends JSON>(obj: T): string => {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
}

const generatePubSubMessage = <T extends JSON>(
  subscription: string,
  data: T,
): UnprocessedPubSubMessage => ({
  subscription: `projects/dummy-project-id-123123/subscriptions/${subscription}`,
  message: {
    // gcp message ids are 15-digit long integer strings
    messageId: `${Math.floor(Math.random() * 10 ** 15)}`,
    data: base64Encode(data),
  },
})

describe('PubSubWrapper', () => {
  afterEach(() => {
    PubSubMock.mockReset()
    topicMock.mockReset()
    publishJSONMock.mockReset()
  })

  describe('Publishing', () => {
    it('Publishes Messages to GCP PubSub', async () => {
      const testProjectId = 'test-project-id'
      const testTopic = 'quote_approved'
      const pubSubMessage = {
        id: 12,
        clientName: 'gio',
      }

      const ps = new PubSub(testProjectId, {})

      await ps.publish(testTopic, pubSubMessage)

      expect(PubSubMock).toHaveBeenCalledTimes(1)
      expect(PubSubMock.mock.calls[0][0]).toEqual({ projectId: testProjectId })

      expect(topicMock).toHaveBeenCalledTimes(1)
      expect(topicMock.mock.calls[0][0]).toEqual(testTopic)

      expect(publishJSONMock).toHaveBeenCalledTimes(1)
      expect(publishJSONMock.mock.calls[0][0]).toEqual(pubSubMessage)
    })
  })

  describe('Subscribing', () => {
    interface Quote {
      id: number
      clientName: string
    }

    describe('Successfully handles incoming events', () => {
      const subscriptionId = 'quote_approved__ticket_message'
      const inMemoryStateManager = new InMemoryStateManager()

      const quoteApprovedSubscriptionHandlerSpy = jest.fn(quote =>
        Promise.resolve(HandlerResult.Success),
      )

      const subscriptionMap = {
        [subscriptionId]: {
          validator: (data: JSON): Quote => {
            return (data as unknown) as Quote
          },
          handler: quoteApprovedSubscriptionHandlerSpy,
        },
      }

      const pubsubMessage = generatePubSubMessage(subscriptionId, {
        id: 12,
        clientName: 'giorgio',
      })

      const ps = new PubSub('test-project-id', subscriptionMap, inMemoryStateManager)

      it('On the first time the message arrives', async () => {
        const cachedEventBeforeSubscriptionHandler = await inMemoryStateManager.getPubSubEvent(
          pubsubMessage.message.messageId,
        )

        expect(cachedEventBeforeSubscriptionHandler).not.toBeDefined()

        const error = await ps.handlePubSubMessage(pubsubMessage)
        expect(error).not.toBeDefined()

        const cachedEventAfterSubscriptionHandler = await inMemoryStateManager.getPubSubEvent(
          pubsubMessage.message.messageId,
        )
        expect(cachedEventAfterSubscriptionHandler?.status).toEqual(
          EventStatus.Completed,
        )

        expect(quoteApprovedSubscriptionHandlerSpy).toHaveBeenCalledTimes(1)
      })

      it('On subsequent invocations, the processsed event is ignored (idempotency)', async () => {
        const error = await ps.handlePubSubMessage(pubsubMessage)
        expect(error).not.toBeDefined()
        expect(quoteApprovedSubscriptionHandlerSpy).toHaveBeenCalledTimes(1)
      })
    })

    describe('Retrying failed events', () => {
      it('Tries to process a failed event multiple times', async () => {
        const inMemoryStateManager = new InMemoryStateManager()
        const subscriptionId = 'quote_approved__ticket_message'

        const quoteApprovedSubscriptionHandlerSpy = jest.fn(quote =>
          Promise.resolve(HandlerResult.FailedToProcess),
        )

        const subscriptionMap = {
          [subscriptionId]: {
            validator: (data: JSON): Quote => {
              return (data as unknown) as Quote
            },
            handler: quoteApprovedSubscriptionHandlerSpy,
          },
        }
        const pubsubMessage = generatePubSubMessage(subscriptionId, {
          id: 12,
          clientName: 'giorgio',
        })

        const ps = new PubSub(
          'test-project-id',
          subscriptionMap,
          inMemoryStateManager,
        )

        const firstError = await ps.handlePubSubMessage(pubsubMessage)
        expect(firstError).toEqual(SubscriptionError.HandlerFailedToProcessMessage)

        const firstCachedEvent = await inMemoryStateManager.getPubSubEvent(
          pubsubMessage.message.messageId,
        )
        expect(firstCachedEvent?.status).toEqual(EventStatus.Failed)

        // need to sleep b/c sometimes last_run_at is the same for both invocations of
        // subscriptionHandler
        await sleepMs(25)

        const secondError = await ps.handlePubSubMessage(pubsubMessage)
        expect(secondError).toEqual(SubscriptionError.HandlerFailedToProcessMessage)

        const secondCachedEvent = await inMemoryStateManager.getPubSubEvent(
          pubsubMessage.message.messageId,
        )
        expect(secondCachedEvent?.status).toEqual(EventStatus.Failed)

        expect(getDate(firstCachedEvent?.last_run_at).getTime()).toBeLessThan(
          getDate(secondCachedEvent?.last_run_at).getTime(),
        )

        expect(quoteApprovedSubscriptionHandlerSpy).toHaveBeenCalledTimes(2)
      })
    })
  })
})
