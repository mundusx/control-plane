import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../../../db/statements/media_usage_totals.sql', import.meta.url), 'utf8');

test('media usage includes durable settlements once and excludes unfinished work', async () => {
  const db = new PGlite();
  try {
    await db.exec('create table public.media_compute_records(job_id text primary key, status text, quote jsonb, generation_ms bigint)');
    const totals = async () => JSON.parse(Object.values((await db.query(sql)).rows[0])[0]);
    const empty = await totals();
    assert.equal(empty.completed_generations, '0');
    assert.equal(empty.average_image_generation_ms, null);
    for (const [id, status, operation, ms, frames] of [
      ['image1', 'settled', 'text_to_image', 1000, null],
      ['image2', 'settled', 'text_to_image', 3000, null],
      ['video', 'settled', 'text_to_video', 6000, 33],
      ['i2v', 'settled', 'image_to_video', 10000, 81],
      ['waiting', 'quoted', 'text_to_image', 900000, null],
    ]) {
      await db.query('insert into media_compute_records values ($1,$2,$3,$4)',
        [id, status, { operation, width: 832, height: 480, steps: 30, frames }, ms]);
    }
    const actual = await totals();
    assert.equal(actual.completed_generations, '4');
    assert.equal(actual.completed_images, '2');
    assert.equal(actual.completed_videos, '2');
    assert.equal(actual.generation_ms, '20000');
    assert.equal(actual.average_image_generation_ms, 2000);
    assert.equal(actual.average_video_generation_ms, 8000);
    assert.equal(Number(actual.image_megapixel_steps), 23.9616);
    assert.equal(Number(actual.video_frame_steps), 3420);
    assert.equal(actual.token_equivalents, null);
    // Completion acknowledgements can be replayed; the job is still counted once.
    await db.query("update media_compute_records set status='settled' where job_id='image1'");
    assert.deepEqual(await totals(), actual);
  } finally { await db.close(); }
});
