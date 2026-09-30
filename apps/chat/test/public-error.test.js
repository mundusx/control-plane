import test from 'node:test';
import assert from 'node:assert/strict';
import { publicErrorMessage } from '../src/shared/http-error.js';

test('public errors never reflect credentials, host paths, or dependency messages', () => {
  for (const statusCode of [undefined, 400, 401, 403, 404, 409, 422, 500, 502]) {
    const error = Object.assign(new Error('postgres://user:password@host /Users/private/.ssh/id_rsa Bearer SECRET'), {statusCode});
    assert.doesNotMatch(publicErrorMessage(error), /password|private|SECRET|postgres|Bearer/);
  }
  assert.equal(publicErrorMessage(null), 'Request failed; please try again');
});
