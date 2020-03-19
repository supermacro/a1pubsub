import { PubSub as GooglePubSub } from '@google-cloud/pubsub'
import { JSON, base64ToParsedJSON } from './json'

type Base64String = string
type MessageId = string

/**
 * This type represents a message whose data has
 * not yet been decoded
 *
 * At this point, you don't yet know if the base64 encoded
 * data conforms to the shape you expect for a particular subscription
 *
 * Secondly, you don't know if the subscription is recognizeable
 */
export interface UnprocessedPubSubMessage {
  subscription: string
  message: {
    messageId: MessageId
    data: Base64String
  }
}

/**
 * This type represents a valid pubsub message
 *
 * A valid pubsub message has a recognized subscription name, and
 * the data conforms to a schema (and whose data came from JSON)
 */
export interface PubSubMessage<T> {
  messageId: MessageId
  data: T
}

export enum SubscriptionError {
  InvalidSubscription = 'invalid_subscription',
  InvalidEventData = 'invalid_event_data',
  MissingHandlerForTopic = 'missing_handler_for_subscription',
  HandlerFailedToProcessMessage = 'handler_failed_to_process_message',
}

export enum EventStatus {
  InProgress = 'in_progress',
  Completed = 'completed',
  Failed = 'failed',
}

export interface PubSubEvent {
  idempotency_key: MessageId
  last_run_at: Date
  created_at: Date
  status: EventStatus
  subscription: string
  base64_event_data: Base64String
}

/**
 * This interface represents any state manager
 *
 * If you want to handle state in a more robust way than
 * in-memory, then you would implement this interface:
 *
 * ```typescript
 * class PostgresStateManager implements StateManager { ... }
 * ```
 */
export interface StateManager {
  getPubSubEvent(messageId: MessageId): Promise<PubSubEvent | undefined>
  recordMessageReceived(
    rawMessage: UnprocessedPubSubMessage,
    subscription: string,
    cachedEvent?: PubSubEvent,
  ): Promise<PubSubEvent>
  recordMessageProcessingOutcome(
    cachedEvent: PubSubEvent,
    outcome: EventStatus,
  ): Promise<void>
}

/**
 * Exported for testing purposes, you do not need to ever import this class
 * as it is being used automatically if you instantiate PubSub without your own
 * state manager (the third argument in the PubSub constructor)
 */
export class InMemoryStateManager implements StateManager {
  private cache: Map<MessageId, PubSubEvent>

  constructor() {
    if (process.env.NODE_ENV !== 'test') {
      const yellowColor = '\x1b[33m%s\x1b[0m'

      const warning = [
        '[a1pubsub]',
        'Currently using the `InMemoryStateManager`',
        'This state manager is only suitable for single-instance applications',
      ].join(' - ')

      console.warn(yellowColor, warning)
    }

    this.cache = new Map()
  }

  async getPubSubEvent(messageId: MessageId): Promise<PubSubEvent | undefined> {
    return this.cache.get(messageId)
  }

  async recordMessageReceived(
    rawMessage: UnprocessedPubSubMessage,
    subscription: string,
    cachedEvent?: PubSubEvent,
  ): Promise<PubSubEvent> {
    const today = new Date()

    if (cachedEvent) {
      const event = {
        ...cachedEvent,
        // eslint-disable-next-line
        last_run_at: today,
      }

      this.cache.set(cachedEvent.idempotency_key, event)

      return event
    } else {
      /* eslint-disable */
      const event = {
        idempotency_key: rawMessage.message.messageId,
        last_run_at: today,
        created_at: today,
        status: EventStatus.InProgress,
        subscription: subscription,
        base64_event_data: rawMessage.message.data,
      }
      /* eslint-enable */

      this.cache.set(rawMessage.message.messageId, event)

      return event
    }
  }

  async recordMessageProcessingOutcome(
    cachedEvent: PubSubEvent,
    outcome: EventStatus,
  ): Promise<void> {
    this.cache.set(cachedEvent.idempotency_key, {
      ...cachedEvent,
      status: outcome,
    })
  }
}

/**
 * Represents the outcome of your `handler` inside of a `SubscriptionHandler`
 */
export enum HandlerResult {
  FailedToProcess = 'failed_to_process',
  Success = 'success',
}

/**
 * Takes deserialized and untyped JSON and either returns data that conforms
 * to a schema or nothing (to represent failed validation)
 *
 * Under the hood, the `a1pubsub` module will catch any errors within this function,
 * so you do not need to implement error handling.
 */
type Validator<T> = (json: JSON) => T | undefined

/**
 * The function that actually processes your validated pubsub event
 *
 * If this function returns `HandlerResult.FailedToProcess` then the retry
 * mechanism as described in the GCP PubSub documentation will kick into place
 */
export type MessageHandler<D extends {}> = (
  subscription: string,
  data: PubSubMessage<D>,
) => Promise<HandlerResult>

export interface SubscriptionHandler<D extends {} = {}> {
  validator: Validator<D>
  handler: MessageHandler<D>
}

/* eslint-disable @typescript-eslint/no-empty-interface, @typescript-eslint/no-explicit-any */
export interface SubscriptionMap extends Record<string, SubscriptionHandler<any>> {}

const subscriptionRe = /^projects\/[a-z-]+\d*\/subscriptions\/(.+)$/

// converts projects/myproject/subscriptions/mysubscription into mysubscription
export const getSubscription = (rawSubscription: string): string | null => {
  const parsed = subscriptionRe.exec(rawSubscription)

  if (!parsed) {
    return null
  }

  return parsed[1]
}

type Either<T, E> = { type: 'ok'; data: T } | { type: 'error'; error: E }

// the developer could throw an exception
// hence we call the validator in a try / catch context
const handleValidator = <T>(
  validator: Validator<T>,
  data: JSON,
): Either<T, SubscriptionError> => {
  try {
    const validatedData = validator(data)

    if (validatedData) {
      return { type: 'ok', data: validatedData }
    } else {
      return { type: 'error', error: SubscriptionError.InvalidEventData }
    }
  } catch (e) {
    return { type: 'error', error: SubscriptionError.InvalidEventData }
  }
}

export class PubSub {
  private projectId: string
  private stateManager: StateManager
  private decoders: SubscriptionMap

  constructor(
    projectId: string,
    decodingTable: SubscriptionMap,
    customStateManager?: StateManager,
  ) {
    this.projectId = projectId

    this.stateManager = customStateManager
      ? customStateManager
      : new InMemoryStateManager()

    this.decoders = decodingTable
  }

  /**
   * Publish an event to a topic
   *
   * This method assumes that your data is serializeable to JSON
   *
   * @param topic the event stream in GCP PubSub
   * @param data the data associated with this event stream
   */
  async publish<J extends {}>(topic: string, data: J): Promise<void> {
    // GCP client libraries use a strategy called Application Default Credentials (ADC)
    // to find the application's credentials.
    // more info: https://cloud.google.com/docs/authentication/production
    const pubSub = new GooglePubSub({
      projectId: this.projectId,
    })

    await pubSub.topic(topic).publishJSON(data)
  }

  /**
   * This is the entrypoint for all pubsub subscription events
   *
   * @param rawMsg An unprocessed pubsub message that must first be validated
   */
  async handlePubSubMessage(
    rawMsg: UnprocessedPubSubMessage,
  ): Promise<SubscriptionError | undefined> {
    const subscription = getSubscription(rawMsg.subscription)

    if (!subscription) {
      return SubscriptionError.InvalidSubscription
    }

    const cachedMessage = await this.stateManager.getPubSubEvent(
      rawMsg.message.messageId,
    )

    if (cachedMessage && cachedMessage.status === EventStatus.Completed) {
      // idempotency :)
      return
    }

    const updatedCachedMessage = await this.stateManager.recordMessageReceived(
      rawMsg,
      subscription,
      cachedMessage,
    )

    const subscriptionHandler = this.decoders[subscription]

    if (!subscriptionHandler) {
      return SubscriptionError.MissingHandlerForTopic
    }

    const { validator, handler } = subscriptionHandler

    const decodedMessage = handleValidator(
      validator,
      base64ToParsedJSON(rawMsg.message.data),
    )

    if (decodedMessage.type === 'error') {
      return decodedMessage.error
    }

    const pubSubMessage = {
      messageId: rawMsg.message.messageId,
      data: decodedMessage.data,
    }

    const handlerResult = await handler(subscription, pubSubMessage).catch(() => {
      // catching in case handler didn't catch its own errors
      return HandlerResult.FailedToProcess
    })
    if (handlerResult === HandlerResult.Success) {
      this.stateManager.recordMessageProcessingOutcome(
        updatedCachedMessage,
        EventStatus.Completed,
      )
      return
    } else {
      this.stateManager.recordMessageProcessingOutcome(
        updatedCachedMessage,
        EventStatus.Failed,
      )

      return SubscriptionError.HandlerFailedToProcessMessage
    }
  }
}
