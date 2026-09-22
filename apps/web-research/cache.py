"""Optional, volatile Redis coordination. Redis failures always fall through to crawling."""
import hashlib
import json
import os
import re
import threading
import time
import unicodedata
import uuid

PREFIX = "research:v1:"
TTL = 300
LEASE = 190
WAIT = 25
RELEASE = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0"
ENQUEUE = """
redis.call('zremrangebyscore',KEYS[1],'-inf',ARGV[1])
if redis.call('zcard',KEYS[1]) >= 64 then return 0 end
redis.call('zadd',KEYS[1],ARGV[2],ARGV[3])
redis.call('expire',KEYS[1],30)
return 1
"""
CLAIM = """
redis.call('zremrangebyscore',KEYS[1],'-inf',ARGV[1])
redis.call('zremrangebyscore',KEYS[2],'-inf',ARGV[1])
if redis.call('zcard',KEYS[1]) < 2 and redis.call('zrange',KEYS[2],0,0)[1] == ARGV[2] then
 redis.call('zrem',KEYS[2],ARGV[2])
 redis.call('zadd',KEYS[1],ARGV[3],ARGV[2])
 redis.call('expire',KEYS[1],200)
 return 1
end
return 0
"""
PUBLISH = """
if redis.call('get',KEYS[1]) == ARGV[1] then
 redis.call('set',KEYS[2],ARGV[2],'EX',5)
 if ARGV[3] == 'yes' then redis.call('set',KEYS[3],ARGV[2],'EX',300) end
 redis.call('del',KEYS[1])
 return 1
end
return 0
"""


def normalized(message):
    text = unicodedata.normalize("NFKC", message).casefold()
    text = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", text)
    return re.sub(r"\s+", " ", text).strip().rstrip("?!.")


def signature(message):
    """Conservative semantic guard: keep all topic, version and constraint words."""
    text = normalized(message)
    text = re.sub(r"^(?:please\s+)?(?:what\s+(?:is|are)|who\s+is|tell\s+me\s+about|explain|describe)\s+", "", text)
    return " ".join(sorted(re.findall(r"\w+", text)))


def shareable(data):
    # Only short, standalone public discovery queries may cross user boundaries.
    message = data["message"]
    return (not data.get("context") and not data.get("urls") and len(message) <= 200
            and bool(re.match(r"^(?:please\s+)?(?:what\s+(?:is|are)|who\s+is|tell\s+me\s+about|explain|describe)\b", message, re.I))
            and not re.search(r"\b(?:my|our|mine|me|us|now|today|latest|live|refresh|again|password|token|secret|email)\b|https?://|@", re.sub(r"^tell me about", "", message, flags=re.I), re.I))


class Embeddings:
    def __init__(self):
        self.model = None
        self.lock = threading.Lock()
        if os.environ.get("WEB_RESEARCH_REDIS_URL"):
            threading.Thread(target=self.load, daemon=True).start()

    def load(self):
        try:
            from fastembed import TextEmbedding
            self.model = TextEmbedding("BAAI/bge-small-en-v1.5", cache_dir="/opt/models", threads=1, local_files_only=True)
        except Exception:
            pass  # Exact matching remains available while embeddings are unavailable.

    def vector(self, message):
        if self.model is None:
            return None
        try:
            with self.lock:
                return next(iter(self.model.embed([normalized(message)]))).tolist()
        except Exception:
            return None


class Coordinator:
    def __init__(self, client=None, embed=None, wait=WAIT):
        self.client = client
        self.embed = embed or (lambda _: None)
        self.wait = wait

    @classmethod
    def configured(cls):
        url = os.environ.get("WEB_RESEARCH_REDIS_URL")
        if not url:
            return cls()
        try:
            import redis
            from redis.backoff import NoBackoff
            from redis.retry import Retry
            embeddings = Embeddings()
            return cls(redis.Redis.from_url(url, socket_connect_timeout=0.3, socket_timeout=0.3,
                                            decode_responses=True, retry=Retry(NoBackoff(), 0)), embeddings.vector)
        except Exception:
            return cls()

    def run(self, data, crawl):
        if self.client is None:
            return crawl(data)
        completed = None
        ticket = uuid.uuid4().hex
        job = None
        owner = False
        try:
            r = self.client
            r.ping()  # Fail before embedding work if Redis is unavailable.
            public = shareable(data)
            scope = json.dumps([data.get("researchMode"), os.environ.get("RESEARCH_MODEL"), signature(data["message"])])
            exact = hashlib.sha256(json.dumps([scope, normalized(data["message"])]).encode()).hexdigest() if public else ticket
            vector = self.embed(data["message"]) if public else None
            job = exact
            # Short admission lock serializes semantic matching plus ownership acquisition.
            deadline = time.monotonic() + 1
            while not r.set(PREFIX + "admission", ticket, nx=True, px=5000):
                if time.monotonic() >= deadline:
                    return 429, {"error": "busy"}
                time.sleep(0.025)
            try:
                if vector:
                    candidates = r.zrevrange(PREFIX + "index", 0, 127)
                    records = r.mget([PREFIX + "meta:" + key for key in candidates]) if candidates else []
                    for candidate, raw in zip(candidates, records):
                        if not raw:
                            continue
                        meta = json.loads(raw)
                        other = meta.get("vector")
                        if meta["scope"] == scope and other and len(other) == len(vector):
                            dot = sum(a*b for a, b in zip(vector, other))
                            norm = (sum(a*a for a in vector)*sum(b*b for b in other)) ** 0.5
                            if norm and dot / norm >= 0.92:
                                job = candidate
                                break
                result = r.get(PREFIX + "result:" + job)
                if result:
                    return self.result(result, "hit")
                owner = bool(r.set(PREFIX + "owner:" + job, ticket, nx=True, ex=LEASE))
                owner_token = ticket if owner else r.get(PREFIX + "owner:" + job)
                if owner and public:
                    r.set(PREFIX + "meta:" + job, json.dumps({"scope": scope, "vector": vector}), ex=TTL)
                    r.zadd(PREFIX + "index", {job: time.time()})
                    r.zremrangebyrank(PREFIX + "index", 0, -129)
                    r.expire(PREFIX + "index", TTL)
            finally:
                r.eval(RELEASE, 1, PREFIX + "admission", ticket)

            if not owner:
                deadline = time.monotonic() + LEASE
                while time.monotonic() < deadline:
                    result = r.get(PREFIX + "done:" + job + ":" + str(owner_token))
                    if result:
                        return self.result(result, "shared")
                    if not r.exists(PREFIX + "owner:" + job):
                        # Publication and owner removal are atomic, but our two reads are not.
                        result = r.get(PREFIX + "done:" + job + ":" + str(owner_token))
                        if result:
                            return self.result(result, "shared")
                        return crawl(data)
                    time.sleep(0.1)
                return 429, {"error": "busy"}

            if not r.eval(ENQUEUE, 1, PREFIX + "pending", time.time(), time.time() + self.wait, ticket):
                return 429, {"error": "busy"}
            deadline = time.monotonic() + self.wait
            while True:
                now = time.time()
                if r.eval(CLAIM, 2, PREFIX + "active", PREFIX + "pending", now, ticket, now + 160):
                    break
                if time.monotonic() >= deadline:
                    return 429, {"error": "busy"}
                time.sleep(0.1)
            completed = crawl(data, timeout=150)
            status, body = completed
            good = status == 200 and not body.get("error") and bool(body.get("sources"))
            # Failed responses are delivered only to existing waiters, never cached for reuse.
            r.eval(PUBLISH, 3, PREFIX + "owner:" + job, PREFIX + "done:" + job + ":" + ticket,
                   PREFIX + "result:" + job, ticket, json.dumps(completed), "yes" if good and public else "no")
            return status, {**body, "_research_cache": "fresh"}
        except Exception:
            # Never repeat an already completed (and possibly billable) crawl.
            return completed if completed is not None else crawl(data)
        finally:
            try:
                self.client.zrem(PREFIX + "active", ticket)
                self.client.zrem(PREFIX + "pending", ticket)
                if owner and job:
                    self.client.eval(RELEASE, 1, PREFIX + "owner:" + job, ticket)
            except Exception:
                pass

    @staticmethod
    def result(raw, mode):
        status, body = json.loads(raw)
        return status, {**body, "_research_cache": mode}
