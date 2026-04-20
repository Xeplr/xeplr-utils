/**
 * Response reader — parses the standard API response format.
 * Isomorphic — works in browser and Node.
 *
 * Usage:
 *   import { readResponse } from 'xeplr-utils/isomorphic';
 *
 *   const result = readResponse(apiResponse);
 *   if (result.ok) {
 *     renderTable(result.dataArray);
 *   } else {
 *     showToast(result.message);
 *     console.log(result.error);
 *   }
 */

/**
 * @param {object} response - The API response body
 * @returns {object} Parsed response with convenience getters
 */
function readResponse(response) {
  const code       = response.code       || '';
  const message    = response.message    || '';
  const error      = response.error      || null;
  const dataArray  = response.dataArray  || [];
  const updatedIds = response.updatedIds || [];

  return {
    code,
    message,
    error,
    dataArray,
    updatedIds,

    /** true if no error object present */
    ok: error === null,

    /** true if error object present */
    hasError: error !== null,

    /** true if dataArray has items */
    hasData: dataArray.length > 0,

    /** true if updatedIds has items */
    hasUpdates: updatedIds.length > 0,

    /** First item from dataArray, or null */
    first: dataArray.length > 0 ? dataArray[0] : null,

    /** Check if response code matches a specific STATUS */
    is(statusCode) {
      return code === statusCode;
    },
  };
}

module.exports = { readResponse };
