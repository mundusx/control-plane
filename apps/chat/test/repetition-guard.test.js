import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoRepetition } from '../src/repetition-guard.js';
const section = '\nNote:\nThis code assumes the system supports the mkdir syscall.\nExample Output:\nAfter running the code, a folder named my_folder will be created in the current directory with permissions 0755.\n';
test('stops three adjacent repeated explanatory sections', () => {
  assert.doesNotThrow(() => assertNoRepetition(section.repeat(2)));
  assert.throws(() => assertNoRepetition(section.repeat(3)), { code: 'mundusx_repetition_detected' });
});
test('allows repeated code, short labels, and separate mentions', () => {
  assert.doesNotThrow(() => assertNoRepetition('```js\n' + section.repeat(5) + '\n```'));
  assert.doesNotThrow(() => assertNoRepetition('Note: '.repeat(20)));
  assert.doesNotThrow(() => assertNoRepetition('x'.repeat(9000)));
  assert.doesNotThrow(() => assertNoRepetition('```js\n' + section.repeat(100) + '\n```'));
  assert.doesNotThrow(() => assertNoRepetition('~~~text\n' + section.repeat(100)));
  assert.doesNotThrow(() => assertNoRepetition(('https://example.com/long-professional-profile-and-company-background\n'.repeat(4)).repeat(3)));
  assert.doesNotThrow(() => assertNoRepetition(section + 'Another explanation.' + section));
});
