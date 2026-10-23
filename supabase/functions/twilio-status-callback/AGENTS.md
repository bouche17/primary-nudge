# twilio-status-callback rules
- twilio-status-callback is public (verify_jwt = false) but 403s any request without a valid X-Twilio-Signature over the full public URL incl. query; every status goes to `message_delivery_status` — why: Twilio calls anonymously and the endpoint must not be spoofable.
