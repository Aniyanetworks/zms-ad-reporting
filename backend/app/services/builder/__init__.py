"""Campaign Builder — chat-driven drafting, code-enforced guardrails, PAUSED creation.

Modules
  schema    Plan / Brief pydantic models (what the model may propose)
  guards    non-negotiable rules applied to every plan (PAUSED, UTMs, names, budget)
  storage   Supabase Storage for uploaded creatives
  meta_graph Marketing API client: account context, geo search, uploads, creation
  chat      Claude conversation: system prompt, tools, streaming turn
  executor  approved plan -> PAUSED objects in the ad account, read back, audit
"""
