import * as Sentry from "@sentry/react";
import { sanitizeSentryEvent } from "@/lib/sentryPrivacy.mjs";

Sentry.init({
  dsn: "https://d06ccdeaec47e9809158d03d9e45b2f2@o4512397798604800.ingest.de.sentry.io/4512397842972752",
  enabled: import.meta.env.PROD,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
  beforeSend: sanitizeSentryEvent,
});
