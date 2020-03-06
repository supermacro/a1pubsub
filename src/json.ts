export type JSONScalar = number | string | boolean | null

export type JSONArray = Array<JSONScalar | JSONObject | JSONArray>

export type JSONObject = {
  [k: string]: JSONScalar | JSONArray | JSONObject
}

export type JSON = JSONScalar | JSONArray | JSONObject

export const base64ToParsedJSON = (base64Data: string): JSON => {
  const stringJson = Buffer.from(base64Data, 'base64').toString()
  return JSON.parse(stringJson)
}
