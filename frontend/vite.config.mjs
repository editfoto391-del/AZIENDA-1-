import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig, loadEnv, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualEdits } from "@emergentbase/visual-edits/vite";

const require = createRequire(import.meta.url);

// Visual Edits (x-* JSX tagging, overlay, /edit-file endpoint) is dev-server-only by
// default (apply: serve).
const visualEditsDisabled = process.env.DISABLE_VISUAL_EDITS === "true";

// Branded error overlay (build + runtime errors); escape hatch mirrors the two above.
const emergentOverlayDisabled = process.env.DISABLE_EMERGENT_OVERLAY === "true";

// Fails open: a broken overlay package must degrade to "no overlay" (Vite's own overlay
// takes over), never to "no dev server". Never let a preview aid take the app down.
async function loadEmergentOverlay() {
  if (emergentOverlayDisabled) return null;
  try {
    const mod = await import("@emergentbase/overlay/vite");
    return mod.emergentOverlay();
  } catch (e) {
    console.warn("[emergent-overlay] plugin failed to load; using Vite's overlay instead:", e instanceof Error ? e.message : e);
    return null;
  }
}

// CRA parity: JSX lives in .js files (App.js, index.js). Vite 8's native transform picks
// the language from the extension and the visual-edits plugin only tags .jsx/.tsx, so .js
// under src/ is handled here: stamp the x-* visual-edit metadata first (dev only, same
// babel plugin the package runs on .jsx), then compile the JSX away with oxc.
function jsxInJs({ tagForVisualEdits }) {
  let tag = null;
  return {
    name: "cra-jsx-in-js",
    enforce: "pre",
    async transform(code, id) {
      const [file] = id.split("?");
      if (!/\/src\/.*\.js$/.test(file) || file.includes("/node_modules/")) return null;
      let source = code;
      let inMap;
      if (tagForVisualEdits) {
        if (!tag) {
          const { transformSync } = require("@babel/core");
          const plugin = require("@emergentbase/visual-edits/babel-plugin").default;
          tag = (src, filename) =>
            transformSync(src, {
              filename,
              plugins: [plugin],
              parserOpts: { plugins: ["jsx", "decorators-legacy", "classProperties"] },
              // Keep the map so oxc chains it: overlay/devtools must point at the authored lines.
              sourceMaps: true,
              configFile: false,
              babelrc: false,
              presets: [],
            });
        }
        const tagged = tag(source, file);
        source = tagged.code;
        inMap = tagged.map;
      }
      return transformWithOxc(source, file, { lang: "jsx", jsx: { runtime: "automatic" } }, inMap);
    },
  };
}

// Pod inotify quota is node-shared and routinely exhausted; native fs.watch EMFILEs at
// boot. Polling keeps file updates and browser HMR reliable on Emergent.
process.env.CHOKIDAR_USEPOLLING = "true";

// https://vite.dev/config/
export default defineConfig(async ({ mode, command }) => {
  const env = loadEnv(mode, __dirname, ["REACT_APP_", "VITE_"]);
  const emergentOverlay = await loadEmergentOverlay();
  return {
    plugins: [
      // Visual-edit tagging is dev-server-only, matching the package's own apply: serve.
      jsxInJs({ tagForVisualEdits: command === "serve" && !visualEditsDisabled }),
      react(),
      tailwindcss(),
      ...(visualEditsDisabled ? [] : [visualEdits()]),
      // No isServe guard: this factory takes no ConfigEnv arg, so build purity here rests
      // on the package's own `apply: "serve"`.
      ...(emergentOverlay ? [emergentOverlay] : []),
    ],
    // CRA parity: REACT_APP_* stays the frontend env convention (frontend/.env).
    envPrefix: ["VITE_", "REACT_APP_"],
    // CRA parity: app code reads `process.env.REACT_APP_*`; Vite has no process.env in the
    // browser, so each REACT_APP_ key is inlined as a compile-time constant.
    define: Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => key.startsWith("REACT_APP_"))
        .map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)]),
    ),
    resolve: {
      alias: [{ find: "@", replacement: path.resolve(__dirname, "./src") }],
    },
    // Every shipped dep, pre-bundled up front. Vite discovers deps lazily, so the first
    // import outside the initial graph would trigger a re-optimize + reload mid-session.
    optimizeDeps: {
      // The dependency scanner runs without user plugins, so it must be told itself that
      // src/**/*.js carries JSX (otherwise it fails the scan and skips pre-bundling).
      rolldownOptions: { moduleTypes: { ".js": "jsx" } },
      include: [
        "@hookform/resolvers",
        "@hookform/resolvers/zod",
        "@radix-ui/react-accordion",
        "@radix-ui/react-alert-dialog",
        "@radix-ui/react-aspect-ratio",
        "@radix-ui/react-avatar",
        "@radix-ui/react-checkbox",
        "@radix-ui/react-collapsible",
        "@radix-ui/react-context-menu",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-hover-card",
        "@radix-ui/react-label",
        "@radix-ui/react-menubar",
        "@radix-ui/react-navigation-menu",
        "@radix-ui/react-popover",
        "@radix-ui/react-progress",
        "@radix-ui/react-radio-group",
        "@radix-ui/react-scroll-area",
        "@radix-ui/react-select",
        "@radix-ui/react-separator",
        "@radix-ui/react-slider",
        "@radix-ui/react-slot",
        "@radix-ui/react-switch",
        "@radix-ui/react-tabs",
        "@radix-ui/react-toast",
        "@radix-ui/react-toggle",
        "@radix-ui/react-toggle-group",
        "@radix-ui/react-tooltip",
        "@tanstack/react-query",
        "axios",
        "class-variance-authority",
        "clsx",
        "cmdk",
        "date-fns",
        "date-fns/locale",
        "dayjs",
        "embla-carousel-react",
        "framer-motion",
        "input-otp",
        "lodash",
        "lodash/debounce",
        "lucide-react",
        "next-themes",
        "prop-types",
        "react",
        "react-day-picker",
        "react-dom/client",
        "react-hook-form",
        "react-is",
        "react-resizable-panels",
        "react-router",
        "react-router-dom",
        "recharts",
        "sonner",
        "swr",
        "tailwind-merge",
        "uuid",
        "vaul",
        "zod",
      ],
    },
    // CRA parity: production bundle lands in build/, not dist/.
    build: { outDir: "build" },
    server: {
      host: true,
      port: 3000,
      allowedHosts: true,
      proxy: env.REACT_APP_BACKEND_URL ? {
        "/__api": {
          target: env.REACT_APP_BACKEND_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/__api/, "/api"),
        },
      } : undefined,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
      // Preview probe + /edit-file are cross-origin from the Emergent tab; Vite defaults to localhost-only CORS.
      cors: true,
      // No hmr.clientPort override: Vite infers the WS target from window.location, which
      // is correct on both localhost:3000 (smoke) and the https/:443 preview proxy.
      // Build-error rendering: emergent-overlay when it loaded, else Vite's own overlay.
      hmr: { overlay: !emergentOverlay },
      watch: { usePolling: true, interval: 300 },
    },
  };
});
