# A1 PubSub

> Keep your pubsub saucy

This package is a wrapper for guaranteeing exactly-once handling of messages from [Google Cloud PubSub](https://cloud.google.com/pubsub/docs/).


#### Table Of Contents:

* [Installation](#installation)
* [Overview (Why & How)](#overview-why--how)
  + [Quick Summary of Google Cloud PubSub Terminology:](#quick-summary-of-google-cloud-pubsub-terminology)
  + [How Does It Work?](#how-does-it-work)
    - [Decoding Table](#decoding-table)
* [Full Example of Subscription Handling With ExpressJS](#full-example-of-subscription-handling-with-expressjs)
* [Security & Authentication](#security--authentication)
* [API Documentation](#api-documentation)



## Installation

```
> npm install a1pubsub
```

This package requries running in a environment with GCP Application Default Credentials

... or maybe provide a service account json from which to authenticate to? Future state


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
- To create a topic:
  - [use the CLI](https://cloud.google.com/pubsub/docs/quickstart-cli#use_the_gcloud_command-line_tool)
    - `gcloud pubsub topics create myTopic`
  - [use the gcp UI](https://cloud.google.com/pubsub/docs/quickstart-console#create_a_topic)
- Topic names must be unique

**Subscription**:
- Subscriptions are topic listeners
- You can have many subscriptions per topic
  - i.e. multiple teams can do different things for the same business event
- You can have push and pull subscriptions
  - Read more info [here](https://cloud.google.com/pubsub/docs/subscriber)
- The data received from a subscription is schemaless
  - you have no guarantee that the data you're receiving adheres to a implied schema in your code. **You must validate your data**.
- To create a subscription:
  - [use the CLI](https://cloud.google.com/pubsub/docs/admin#creating_subscriptions)
    - `gcloud pubsub subscriptions create --topic myTopic mySubscriptionName`
  - [use the gcp UI](https://cloud.google.com/pubsub/docs/quickstart-console#add_a_subscription)
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

const decodingTable = justHoldYourHorsesForASecond

const ps = new PubSub(myGcpProjecId, decodingTable)
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


#### Decoding Table

So in the above code snippet, you saw that `PubSub` was instantiated with a `decodingTable`.

Before I get to explaining in plain english, here is the type definition:

```typescript
type SubscriptionId = string

interface SubscriptionHandler<T extends {}> {
  validator: (json: JSON) => T
  handler: (data: T) => Promise<boolean>
}

export type DecodingTable<T extends {}> = Map<SubscriptionId, SubscriptionHandler<T>>
```

In plain english: A decoding table is a `Map` whose keys are strings (that represent subscription identifiers), and whose values are `SubscriptionHandler`s.

A `SubscriptionHandler` is an object with two keys:
- `validator`: As I mentioned alredy, GCP pubsub data is schemaless. All you know is that the data is serializeable to json.
  - the `JSON` type is defined in `src/json.ts` and it's just a type-level definition of `JSON.parse`.
- `handler`: The actual subscription handler, it takes your validated data and returns a promise with a boolean.
  - Feel free to do whatever you want here, the only requirement is that you must return a promise with a boolean value.
  - `true`: success, any subsequent messages that GCP pubsub might deliver will get ignored
    - **you, the developer** must send a 2XX HTTP response to google cloud pubsub so that it knows that the event has been processed
  - `false`: failure, the event will be tracked, but our system will be expecting that same event from being delivered again on a retry
    - **you, the developer** must send a non 2XX HTTP response to google cloud pubsub so that it knows to retry later

So if your pubsub module needs to handle 5 subscriptions, then your `DecodingTable` will have 5 keys, and 5 corresponding `SubscriptionHandler`s.


## Full Example of Subscription Handling With ExpressJS

```typescript
import express from 'express'
import { PubSub } from 'a1pubsub'
import * as Joi from '@hapi/joi'

const app = express()
const port = 3000


const myGcpProjecId = 'setter-develop-82828'

const decodingTable = new Map()

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

decodingTable.set('quote_approved', {
  validator: (data) => {
    // using joi here ... but you can use anything you want
    // runtypes, yum, validatorjs etc etc etc
    const { approvedQuoteData, error } = Joi.object(quoteApprovedSchema)
      .options({ stripUnknown: true })
      .validate(data)

    if (approvedQuoteData) {
      return approvedQuoteData
    } else {
      return
    }
  },
  handler: sendQuoteApprovalEmailToClient,
})


decodingTable.set('job_cancelled', {
  validator: (data) => {
    const { cancelledJobData, error } = Joi.object(jobCancelledSchema)
      .options({ stripUnknown: true })
      .validate(data)

    if (cancelledJobData) {
      return cancelledJobData
    }
  },
  handler: refundClient
})

/*
 * pretend a whole bunch of SubscriptionId + SubscriptionHandler pairs
 * have been added to the decodingTable Map
 * to handle all the various subscriptions
 */


const ps = new PubSub(myGcpProjecId, decodingTable)

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


## API Documentation

[link](https://priceless-meitner-38fa2b.netlify.com/classes/_index_.pubsub.html)
