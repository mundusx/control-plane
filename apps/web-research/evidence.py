"""Broad discovery and bounded page retrieval, without fixed source categories."""
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit


def query_variants(request):
    text = str(request["message"]).strip()
    context = str(request.get("context", ""))[-1800:]
    subject = re.sub(r"^(?:what is|what's|who is|who's|tell me about|do you know|have you heard of)\s+", "", text, flags=re.I).rstrip(" ?.!。")
    if context:
        subject = context + " " + subject
    subject = " ".join(subject.split())[:360]
    # Search both literal and separated version names (kimi3 -> kimi 3),
    # without asserting that either spelling identifies a particular product.
    spaced = re.sub(r"(?<=[A-Za-z])(?=\d)", " ", subject)
    return list(dict.fromkeys([subject, spaced + " official information"]))


def collect_evidence(request, search, read_page, pages):
    def lookup(query):
        try:
            return list(pages(json.loads(search(query, limit=6))))
        except Exception:
            return []

    with ThreadPoolExecutor(max_workers=2) as pool:
        batches = list(pool.map(lookup, query_variants(request)))
    # Interleave independent queries instead of letting the first one monopolize
    # evidence. Keep diverse origins and exclude biographical GitHub mentions.
    candidates, seen, hosts = [], set(), {}
    for index in range(max((len(batch) for batch in batches), default=0)):
        for batch in batches:
            if index >= len(batch):
                continue
            url, snippet = batch[index]
            parsed = urlsplit(url)
            host = (parsed.hostname or "").removeprefix("www.")
            if request.get("researchMode") in ("biography", "public_profiles") and host == "github.com" and len(parsed.path.strip("/").split("/")) > 1:
                continue
            if url in seen or hosts.get(host, 0) >= 2:
                continue
            seen.add(url)
            hosts[host] = hosts.get(host, 0) + 1
            candidates.append((url, snippet))
            if len(candidates) == 6:
                break
        if len(candidates) == 6:
            break

    def retrieve(entry):
        url, snippet = entry
        try:
            page = read_page(url)
        except Exception:
            page = None
        if page:
            return url, "Retrieved public page (search snippet is not verification):\n" + page["content"][:9000]
        return url, "Search snippet only; full page could not be retrieved:\n" + snippet[:3000]

    with ThreadPoolExecutor(max_workers=3) as pool:
        retrieved = list(pool.map(retrieve, candidates[:3]))
    retrieved += [(url, "Search snippet only:\n" + snippet[:3000]) for url, snippet in candidates[3:]]
    return retrieved


def answer_sources(answer, retrieved_urls):
    """Prefer sources actually cited, and never advertise unobserved URLs."""
    allowed = set(retrieved_urls)
    cited = re.findall(r"\]\((https?://[^\s)]+)\)|<(https?://[^\s>]+)>", answer)
    selected = list(dict.fromkeys(url for pair in cited for url in pair if url in allowed))[:3]
    return selected or list(dict.fromkeys(retrieved_urls))[:3]
