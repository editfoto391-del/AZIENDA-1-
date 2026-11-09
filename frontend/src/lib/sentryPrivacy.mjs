const PRIVATE_EVENT_FIELDS = [
  "request",
  "user",
  "contexts",
  "breadcrumbs",
  "extra",
  "tags",
  "transaction",
  "message",
  "logentry",
  "culprit",
  "fingerprint",
  "debug_meta",
];

export function sanitizeSentryEvent(event) {
  const sanitized = { ...event };
  PRIVATE_EVENT_FIELDS.forEach((field) => delete sanitized[field]);

  if (event.exception?.values) {
    sanitized.exception = {
      ...event.exception,
      values: event.exception.values.map((exception) => {
        const safeException = { ...exception };
        delete safeException.value;
        if (safeException.mechanism) {
          safeException.mechanism = { ...safeException.mechanism };
          delete safeException.mechanism.data;
          delete safeException.mechanism.meta;
        }
        if (safeException.stacktrace?.frames) {
          safeException.stacktrace = {
            ...safeException.stacktrace,
            frames: safeException.stacktrace.frames.map((frame) => {
              const safeFrame = { ...frame };
              ["vars", "pre_context", "context_line", "post_context"].forEach((field) => {
                delete safeFrame[field];
              });
              ["filename", "abs_path"].forEach((field) => {
                if (typeof safeFrame[field] === "string") {
                  safeFrame[field] = safeFrame[field].split(/[?#]/, 1)[0];
                }
              });
              return safeFrame;
            }),
          };
        }
        return safeException;
      }),
    };
  }

  return sanitized;
}
