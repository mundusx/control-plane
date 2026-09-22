import unittest
from unittest.mock import patch, MagicMock
import sys
import types
import json
import os
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from server import Handler
from public_read import PageText, read_public_page
from research import pages, biography_source
from evidence import query_variants, collect_evidence, answer_sources


class ReaderTests(unittest.TestCase):
    def test_broad_queries_do_not_assume_platforms_or_known_products(self):
        self.assertEqual(query_variants({"message": "what is kimi3?"}), ["kimi3", "kimi 3 official information"])
        queries = query_variants({"message": "what is muse glimmer"})
        self.assertTrue(all("muse glimmer" in query for query in queries))
        self.assertFalse(any("site:" in query or "github" in query or "linkedin" in query for query in queries))
        self.assertIn("Dave Batalla", query_variants({"message": "did you check linkedin", "context": "Who is Dave Batalla?"})[0])

    def test_broad_retrieval_reads_pages_and_preserves_snippet_labels(self):
        def search(query, limit):
            return json.dumps({"results": [{"url": "https://creator.test/release", "snippet": "Creator announcement"},
                {"url": "https://news.test/report", "snippet": "Independent report"}]})
        evidence = collect_evidence({"message": "what is NewModel9?"}, search,
            lambda url: {"content": "Full current release notes"} if "creator" in url else None, pages)
        self.assertEqual(len(evidence), 2)
        self.assertIn("Full current release notes", evidence[0][1])
        self.assertIn("Search snippet only", evidence[1][1])
        self.assertEqual(collect_evidence({"message": "what is NewModel9?"}, lambda *a, **k: '{}', lambda url: None, pages), [])

    def test_biography_excludes_github_pull_request_mentions(self):
        url = "https://github.com/theneworacle/site/pull/7742"
        search = lambda *a, **k: json.dumps({"results": [{"url": url, "snippet": "Alex Eala"}]})
        self.assertEqual(collect_evidence({"message": "who is alex eala", "researchMode": "biography"}, search, lambda url: None, pages), [])

    def test_final_sources_prioritize_citations_and_limit_to_three_observed_urls(self):
        urls = [f"https://source{i}.test" for i in range(5)]
        self.assertEqual(answer_sources("[evidence](https://source4.test) [invented](https://unknown.test)", urls), [urls[4]])
        self.assertEqual(len(answer_sources("No links", urls)), 3)

    def test_visible_text_and_links(self):
        parser = PageText("https://example.com/")
        parser.feed('<h1>Website</h1><script>secret code</script><style>hidden</style><a href="/pricing">Plans</a>')
        self.assertEqual(parser.parts, ["Website", "Plans"])
        self.assertEqual(parser.links, ["https://example.com/pricing"])

    def test_failed_sources_are_not_evidence(self):
        result = {"results": [{"url": "https://a.test", "content": "text"},
                              {"url": "https://b.test", "content": "denied", "error": "403"}]}
        self.assertEqual(list(pages(result)), [("https://a.test", "text")])

    def test_private_redirect_is_not_requested(self):
        client = MagicMock()
        client.__enter__.return_value = client
        response = MagicMock(is_redirect=True, headers={"location": "http://127.0.0.1/admin"})
        client.stream.return_value.__enter__.return_value = response
        safety = types.ModuleType("tools.url_safety")
        safety.create_ssrf_safe_client = lambda **kwargs: client
        safety.is_safe_url = lambda url: url.startswith("https://example.com")
        policy = types.ModuleType("tools.website_policy")
        policy.check_website_access = lambda url: None
        extract = types.ModuleType("tools.web_tools_extract")
        extract._validate_extract_urls = lambda urls: (urls, [0], {}, None)
        with patch.dict(sys.modules, {"tools": types.ModuleType("tools"), "tools.url_safety": safety,
                                     "tools.website_policy": policy, "tools.web_tools_extract": extract}):
            self.assertIsNone(read_public_page("https://example.com"))
        self.assertEqual(client.stream.call_count, 1)

    def test_service_auth_and_partial_analysis_failure(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/research"
        process = MagicMock()
        process.communicate.return_value = ('\n'.join([
            json.dumps({"event": "retrieved", "excerpt": "Actual page content", "sources": ["https://example.com"]}),
            json.dumps({"event": "result", "error": "provider_error", "content": "failed", "sources": []}),
        ]), None)
        try:
            with patch.dict(os.environ, {"WEB_RESEARCH_TOKEN": "test"}), patch("server.subprocess.Popen", return_value=process):
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(urllib.request.Request(url, data=b'{}'))
                self.assertEqual(denied.exception.code, 401)
                request = urllib.request.Request(url, data=b'{"message":"read website","urls":[]}',
                                                 headers={"Authorization": "Bearer test"})
                result = json.load(urllib.request.urlopen(request))
                self.assertEqual(result["error"], "incomplete")
                self.assertIn("Actual page content", result["content"])
                self.assertEqual(result["sources"], ["https://example.com"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
