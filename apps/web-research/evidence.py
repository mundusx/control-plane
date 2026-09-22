"""Broad discovery and bounded page retrieval, without fixed source categories."""
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit


def person_name(request):
    if request.get("researchMode") not in ("biography", "public_profiles"):
        return ""
    for text in reversed((str(request.get("context", "")) + "\n" + request["message"]).splitlines()):
        match = re.search(r"(?:who is|who's|tell me about|profile (?:for|of)|osint|research)\s+([^?.!\n]+)", text, re.I)
        if match:
            name = re.split(r"\s+(?:on|from|at|working|who|in)\s+", match.group(1), flags=re.I)[0].strip()
            if 2 <= len(name.split()) <= 4 and not re.search(r"\b(?:the|a|an|linkedin|github|website|profile)\b", name, re.I):
                return name
    return ""


def matches_person(name, url, text):
    if not name:
        return True
    first, last = name.casefold().split()[0], name.casefold().split()[-1]
    pattern = r"\b" + re.escape(first) + r"\w*(?:[\s_\-'’]+\w+){0,3}[\s_\-'’]+" + re.escape(last) + r"\b"
    parsed = urlsplit(url)
    # Mentions in somebody else's endorsements do not establish their identity.
    if (parsed.hostname or "").endswith("linkedin.com") and parsed.path.startswith("/in/"):
        return bool(re.search(pattern, parsed.path.casefold()))
    return bool(re.search(pattern, (url + " " + text).casefold()))


def query_variants(request):
    name = person_name(request)
    if name:
        exact = '"' + name + '"'
        return [exact, exact + " biography background", exact + " site:linkedin.com/in/"]
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
    name = person_name(request)
    def lookup(query):
        try:
            return list(pages(json.loads(search(query, limit=6))))
        except Exception:
            return []

    with ThreadPoolExecutor(max_workers=3) as pool:
        batches = list(pool.map(lookup, query_variants(request)))
    # Interleave independent queries instead of letting the first one monopolize
    # evidence. Keep diverse origins and exclude biographical GitHub mentions.
    candidates, seen, hosts = [], set(), {}
    for index in range(max((len(batch) for batch in batches), default=0)):
        for batch in batches:
            if index >= len(batch):
                continue
            url, snippet = batch[index]
            if not matches_person(name, url, snippet):
                continue
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
        if page and matches_person(name, page.get("url", url), page["content"]):
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
