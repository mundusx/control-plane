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

const dependencies = 'axum = "0.6.1"\nserde_json = "1.0"\ntokio = { version = "1.0", features = ["full"] }\ntokio_postgres = { version = "0.7", features = ["tls"] }\ntokio_rds = "0.1"\n';
test('stops sustained dependency loops inside complete and unfinished code fences', () => {
  for (const fence of ['```toml', '~~~toml']) {
    assert.doesNotThrow(() => assertNoRepetition(fence + '\n' + dependencies.repeat(3)));
    assert.throws(() => assertNoRepetition(fence + '\n' + dependencies.repeat(8)), { code: 'mundusx_repetition_detected' });
    assert.throws(() => assertNoRepetition(fence + '\n' + dependencies.repeat(100) + '\n' + fence.slice(0, 3)), { code: 'mundusx_repetition_detected' });
  }
});
test('allows similar CRUD methods and repeated comment blocks', () => {
  const methods = Array.from({length: 20}, (_, i) => `fn handler_${i}() {\n    let value = ${i};\n    println!("{}", value);\n}\n`).join('');
  assert.doesNotThrow(() => assertNoRepetition('```rust\n' + methods + '\n```'));
  assert.doesNotThrow(() => assertNoRepetition('```js\n' + '// long explanatory comment about the handler and its behavior\n'.repeat(100) + '```'));
});
