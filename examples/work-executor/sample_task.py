#!/usr/bin/env python3
"""Demonstrate one real fixed command reading Home's immutable input snapshot."""
import json
import sys

payload = json.load(sys.stdin)
item = payload["item"]
print(json.dumps({
    "runId": payload["id"],
    "itemId": item.get("id"),
    "title": item.get("title", ""),
    "message": "The reference command read this snapshot successfully."
}, ensure_ascii=False))
