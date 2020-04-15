# A1 PubSub

[![Build Status](https://travis-ci.com/Setter/a1pubsub.svg?branch=master)](https://travis-ci.com/Setter/a1pubsub)

> Keep your pubsub saucy

This package is a wrapper for guaranteeing exactly-once handling of messages from [Google Cloud PubSub](https://cloud.google.com/pubsub/docs/).


#### Table Of Contents:

* [Installation](#installation)
* [API Documentation](#api-documentation)
* [Overview (Why & How)](#overview-why--how)
  + [Quick Summary of Google Cloud PubSub Terminology:](#quick-summary-of-google-cloud-pubsub-terminology)
  + [How Does It Work?](#how-does-it-work)
    - [Subscription Handlers](#subscription-handlers)
* [Full Example of Subscription Handling With ExpressJS](#full-example-of-subscription-handling-with-expressjs)
* [Security & Authentication](#security--authentication)
* [Providing Alternative State Managers](#providing-alternative-state-managers)




## Installation

```
> npm install a1pubsub
```

This package requries running in a environment with GCP Application Default Credentials. If you authenticate on your machine using the `gcloud` cli, then you're good to go!


## API Documentation

[link](https://setter-a1pubsub.netlify.com/classes/_index_.pubsub.html)

## Local Development

When developing on your machine, you will want to publish events and also receive them (once you've configured a subscription).

#### Publishing PubSub Events

Trigger the "flow" that contains the `.publish` API call. Example, if you want to trigger the quote approval pubsub event, then approve a quote.

Whatever environment (local, staging) this event was invoked in will transmit the event over to GCP PubSub.

One of three things will subsequently occur:

- Error: The topic you tried publishing to does not exist
- Success and then nothing: The topic you tried publishing to does exist, but there are no subscriptions for this topic, so it's essentially a no-op
- Success and then delivery to subscriber(s): The topic you tried publishing to does exist, and there are subscribers that are set up as either pull or push.
  - if they're push subscribers, then they'll recive the message in near-realtime.


#### Receiving PubSub Events to your machine

Let's suppose that you're working with push subscriptions. The question is then, how do you get GCP pubsub to stream events to your machine? 

Steps:

- Make sure your http server is running and has a port exposed
- Make sure you have [ngrok](https://ngrok.com/) installed on your machine
- Run ngrok as follows:

```
$> ~/ngrok http <PORT_NUMBER> 
```

You'll now have a url such as https://c251a9ae.ngrok.io that you can copy/paste into the GCP pubsub UI.

If your HTTP server has a request handler set up at `/webhooks/pubsub` then you'll want to paste https://c251a9ae.ngrok.io/webhooks/pubsub into the GCP PubSub UI for the PubSub URL.


## Overview (Why & How)

Setter needs one-to-many relationships between events that are published and the corresponding event handlers. i.e. We would like to emit an event such as `JOB_APPROVED`, and have various services be able to do different things with those events independently.

The way GCP PubSub works is that it delivers messages to every subscriber **at least once** ([docs](https://cloud.google.com/pubsub/docs/subscriber)). Thus, if you have a system that must only process events exactly once, you have to implement idempotence yourself.

**This package is intended to abstract away the need to manage idempotence yourself.**

### Quick Summary of Google Cloud PubSub Terminology:

What follows is a tldr of the actual GCP documentation located at: https://cloud.google.com/pubsub/docs

**Topic**:
- A topic is an event stream
  - Example: you could have an event stream of `quote_approved` events, and then a separate stream for `job_scheduled` events, etc etc
- You publish events to topics
  - Publishing has two components:
    - The topic / event stream name
    - The associated data (must be serializeable to JSON)
- GCP PubSub has a limt of 10,000 topics per project ([source](https://cloud.google.com/pubsub/quotas#other_limits))
- To create a topic, [use the gcp UI](https://cloud.google.com/pubsub/docs/quickstart-console#create_a_topic)
- Topic names must be unique

**Subscription**:
- Subscriptions are topic listeners
- You can have many subscriptions per topic
  - i.e. multiple teams can do different things for the same business event
- You can have push and pull subscriptions
  - Read more info [here](https://cloud.google.com/pubsub/docs/subscriber)
- The data received from a subscription is schemaless
  - you have no guarantee that the data you're receiving adheres to a implied schema in your code. **You must validate your data**.
- To create a subscription, [use the gcp UI](https://cloud.google.com/pubsub/docs/quickstart-console#add_a_subscription)
  - Ensure you enable authentication for your subscription
  - Set the endpoint appropriately
    - For local development, I recomment you use [ngrok](https://ngrok.com/)
- Subscription names must be unique


### How Does It Work?

Let's do a code-a-long...

First, import the `PubSub` class from `a1pubsub`

```typescript
import { PubSub } from 'a1pubsub'
```

Let's instantiate the `PubSub` class:

```typescript
const myGcpProjecId = 'setter-develop-82828'

const subscriptionHandlers = {} // more to come here soon

const ps = new PubSub(myGcpProjecId, subscriptionHandlers)
```

When you instantiate `PubSub`, the module will try to authenticate to gcp using [Application Default Credentials](https://cloud.google.com/docs/authentication/production#finding_credentials_automatically). 

Please take 5 minutes to familiarize yourself with ADC, as this is the only way to authenticate to GCP PubSub for the moment. Regardless, here's what you need to know when developing on your machine:

- You **must** have the `gcloud` CLI installed on your machine
  - https://cloud.google.com/sdk/gcloud/
- You **must** be authenticated via the `gcloud` CLI to the corresponding project that you're trying to work with
  - For example, in the above code snippet, I am instantiating `PubSub` with the `'setter-develop-82828'` project - thus I must be authenticated via `gcloud auth` to that project as well


Now that you've instantiated `PubSub`, you can now publish events!

```typescript
await ps.publish(
  'quote_approved', // topic name
  { id: 1232, title: 'Window Cleaning', client_first_name: 'Jerry' } // data - must be serializeable to JSON
)
```

Note that any topic that you publish to must already exist! See the links above for creating topics.

Note For Setter engineers: Create topics sparringly and with good reason. Try to adhere to creating topics that represent events that have occurred. Don't create a topics that represent actions to be done. For more context, refer to [this talk](https://rangle.slides.com/yazanalaboudi/deck#/).

Ok back to the code along.


#### Subscription Handlers

So in the above code snippet, you saw that `PubSub` was instantiated with a `subscriptionHandlers` object. The type of `subscriptionHandlers` must be `SubscriptionMap`.

A `SubscriptionHandler` is a plain js object whose keys are strings (that represent subscription identifiers), and whose values are a object of type `SubscriptionHandler`, a `SubscriptionHandler` contains:

- `validator`: As I mentioned alredy, GCP pubsub data is schemaless. All you know is that the data is serializeable to json.
  - the `JSON` type is defined in `src/json.ts` and it's just a type-level definition of `JSON.parse`.
- `handler`: The actual subscription handler, it takes your validated data and returns a promise with a boolean.
  - Feel free to do whatever you want here, the only requirement is that you must return a promise with a `HandlerResult` value.
  - `HandlerResult.Success`: any subsequent messages that GCP pubsub might deliver will get ignored
    - **you, the developer** must send a 2XX HTTP response to google cloud pubsub so that it knows that the event has been processed
  - `HandlerResult.FailedToProcess`: the event will be tracked, but our system will be expecting that same event from being delivered again on a retry
    - **you, the developer** must send a non 2XX HTTP response to google cloud pubsub so that it knows to retry later

So if your pubsub module needs to handle 5 subscriptions, then your `SubscriptionMap` will have 5 keys, and 5 corresponding `SubscriptionHandler`s.


## Full Example of Subscription Handling With ExpressJS

```typescript
import express from 'express'
import { PubSub } from 'a1pubsub'
import * as Joi from '@hapi/joi'

import { SubscriptionMap, HandlerResult } from 'a1pubsub'

import { notifyClientViaTicketComment } from './quote-approved/zendesk-notification'
import { quoteApprovalValidator, ApprovedQuoteData } from './quote-approved'

// defining the shape of our specific SubscriptionMap
declare module 'a1pubsub' {
  interface SubscriptionMap {
    quote_approved__client_ticket_comment: SubscriptionHandler<
      ApprovedQuoteData
    >

    job_cancelled__pro_sms: SubscriptionHandler<{ example: string }>
  }
}

/* eslint-disable @typescript-eslint/camelcase */
export const eventHandlers: SubscriptionMap = {
  quote_approved__client_ticket_comment: {
    validator: quoteApprovalValidator.check,
    handler: notifyClientViaTicketComment,
  },
  job_cancelled__pro_sms: {
    validator: data => data as { example: 'testing' },
    handler: data => {
      console.log(data)
      return Promise.resolve(HandlerResult.Success)
    },
  },
}


const app = express()
const port = 3000


const myGcpProjecId = 'setter-develop-82828'

const quoteApprovedSchema = {
  quote_id: Joi.number().required()
  title: Joi.string().required(),
  client_first_name: Joi.string().required(),
}

/*
 * pretend a whole bunch of other schemas were defined here
 * such as:
 *   - jobCancelledSchema
 *   - homeConsultationCompleted
 *   - purchaseOrderCreated
 *   - jobCompleted
 *   - etc etc
 */




const ps = new PubSub(myGcpProjecId, eventHandlers)

app.post('/pubsub', async (req, res) => {
  const pubsubMessage = req.body

  // if error is undefined, then all went well
  // the PubSub module will guarantee that duplicate messages
  // are not processed again
  const error = await ps.handlePubSubMessage(pubsubMessage)

  if (error) {
    // GCP PubSub will re-enqueue the message and retry at a later point in time
    res.sendStatus(422)
  } else {
    // GCP PubSub will **PROBABLY** not send the same message again
    res.sendStatus(204)
  }
})

app.listen(port, () => console.log(`Example app listening on port ${port}!`))
```

## Security & Authentication

Note that by default, your pubsub events are not authenticated. Please ensure that you authenticate events. More info: https://cloud.google.com/pubsub/docs/authentication


## Providing Alternative State Managers

Out of the box, idempotency is implemented / managed via an in-memory hash map (using the js `Map`). But you can provide your own persistence mechanism so long as it implements the `StateManager` interface ([link](https://priceless-meitner-38fa2b.netlify.com/interfaces/_index_.statemanager.html)).

Example:

```typescript
import { PubSub } from 'a1pubsub'

new PubSub('my-project-id', eventHandlers, psqlStateManager)
```
