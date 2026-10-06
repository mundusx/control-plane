import concurrent.futures
import threading
import time
import unittest
from unittest.mock import Mock
import fakeredis
from cache import Coordinator, PREFIX, normalized, signature, shareable

ANSWER = (200, {"content": "Verified answer", "sources": ["https://example.com"]})


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.redis = fakeredis.FakeRedis(decode_responses=True)
        self.coordinator = Coordinator(self.redis, embed=lambda _: [1., 0.])
        self.query = {"message": "What is Kimi3?"}

    def test_normalization_and_topic_guards(self):
        self.assertEqual(normalized("WHAT is Kimi 3??"), normalized("what is kimi3"))
        self.assertEqual(signature("Tell me about Kimi 3"), signature("what is kimi3"))
        for text in ["what is kimi 4", "what is kimi 3 pricing", "what is not kimi 3"]:
            self.assertNotEqual(signature(text), signature(self.query["message"]))
        self.assertFalse(shareable({"message": "what is my account balance"}))
        self.assertFalse(shareable({"message": "what is kimi 3", "context": "private details"}))
        self.assertFalse(shareable({"message": "what is kimi 3 today"}))

    def test_ten_requests_share_one_crawl(self):
        barrier = threading.Barrier(10)
        def crawl(*args, **kwargs):
            time.sleep(.5)
            return ANSWER
        run = Mock(side_effect=crawl)
        def request(i):
            barrier.wait()
            return self.coordinator.run({"message": "WHAT IS KIMI 3?" if i % 2 else "what is kimi3"}, run)
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(request, range(10)))
        self.assertEqual(run.call_count, 1)
        self.assertTrue(all(item[1]["content"] == ANSWER[1]["content"] for item in results))
        self.assertEqual(self.redis.zcard(PREFIX + "active"), 0)

    def test_person_punctuation_case_spacing_and_contractions_share_cache(self):
        crawl = Mock(return_value=ANSWER)
        for message in ["who is alex eala?", "who is alex eala_?", " WHO IS Alex   Eala__?! ", "who’s alex eala?", "ｗｈｏ is alex eala？"]:
            self.coordinator.run({"message": message, "researchMode": "biography"}, crawl)
        self.assertEqual(crawl.call_count, 1)

    def test_normalization_does_not_erase_identity_or_technical_meaning(self):
        for left, right in [("who is alex eala", "who is alex ealla"),
                            ("what is C++", "what is C"), ("what is C#", "what is C"),
                            ("what is model 3.5", "what is model 35"),
                            ("what is user_name_", "what is user_name"),
                            ("what is alice following bob", "what is bob following alice")]:
            self.assertNotEqual(signature(left), signature(right))
        self.assertEqual(signature("what’s kimi3?"), signature("what is kimi 3"))

    def test_semantic_match_preserves_intent_and_versions(self):
        crawl = Mock(return_value=ANSWER)
        self.coordinator.run(self.query, crawl)
        result = self.coordinator.run({"message": "Tell me about Kimi 3"}, crawl)
        self.assertEqual(result[1]["_research_cache"], "hit")
        self.coordinator.run({"message": "what is kimi 4"}, crawl)
        self.coordinator.run({"message": "what is kimi 3 pricing"}, crawl)
        self.assertEqual(crawl.call_count, 3)
        key = self.redis.keys(PREFIX + "result:*")[0]
        self.assertGreater(self.redis.ttl(key), 0)
        self.redis.delete(*self.redis.keys(PREFIX + "result:*"))
        self.coordinator.run(self.query, crawl)
        self.assertEqual(crawl.call_count, 4)

    def test_no_redis_and_outage_use_direct_crawl(self):
        crawl = Mock(return_value=ANSWER)
        Coordinator().run(self.query, crawl)
        broken = Mock()
        broken.ping.side_effect = ConnectionError()
        Coordinator(broken).run(self.query, crawl)
        self.assertEqual(crawl.call_args_list[0].args, (self.query,))
        self.assertEqual(crawl.call_args_list[1].kwargs, {})
        self.assertEqual(crawl.call_count, 2)

    def test_failure_after_crawl_does_not_repeat_work(self):
        original = self.redis.eval
        def eval_script(script, *args):
            if "ARGV[3] == 'yes'" in script:
                raise ConnectionError()
            return original(script, *args)
        self.redis.eval = eval_script
        crawl = Mock(return_value=ANSWER)
        self.assertEqual(self.coordinator.run(self.query, crawl), ANSWER)
        self.assertEqual(crawl.call_count, 1)

    def test_error_not_cached_and_private_context_not_shared(self):
        crawl = Mock(return_value=(503, {"error": "unavailable"}))
        self.coordinator.run(self.query, crawl)
        self.coordinator.run(self.query, crawl)
        self.assertEqual(crawl.call_count, 2)
        self.assertEqual(self.redis.keys(PREFIX + "result:*"), [])
        crawl.return_value = ANSWER
        private = {**self.query, "context": "user private history"}
        self.coordinator.run(private, crawl)
        self.coordinator.run(private, crawl)
        self.assertEqual(crawl.call_count, 4)

    def test_two_active_crawls_and_queue_timeout(self):
        self.redis.zadd(PREFIX + "active", {"one": time.time()+50, "two": time.time()+50})
        crawl = Mock(return_value=ANSWER)
        result = Coordinator(self.redis, wait=.15).run(self.query, crawl)
        self.assertEqual(result[0], 429)
        crawl.assert_not_called()
        self.assertEqual(self.redis.zcard(PREFIX + "pending"), 0)

    def test_distinct_questions_queue_with_two_running(self):
        lock = threading.Lock()
        counts = {"active": 0, "peak": 0, "calls": 0}
        def crawl(*args, **kwargs):
            with lock:
                counts["active"] += 1
                counts["calls"] += 1
                counts["peak"] = max(counts["peak"], counts["active"])
            time.sleep(.2)
            with lock:
                counts["active"] -= 1
            return ANSWER
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda i: self.coordinator.run({"message": f"what is model {i}"}, crawl), range(4)))
        self.assertEqual(counts["peak"], 2)
        self.assertEqual(counts["calls"], 4)
        self.assertTrue(all(result[0] == 200 for result in results))

    def test_failed_crawl_is_shared_with_waiters_but_later_retried(self):
        def failure(*args, **kwargs):
            time.sleep(.3)
            return 503, {"error": "unavailable"}
        crawl = Mock(side_effect=failure)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.coordinator.run(self.query, crawl), range(4)))
        self.assertEqual(crawl.call_count, 1)
        self.assertTrue(all(result[0] == 503 for result in results))
        self.coordinator.run(self.query, crawl)
        self.assertEqual(crawl.call_count, 2)


if __name__ == "__main__":
    unittest.main()
