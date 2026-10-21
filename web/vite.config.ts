import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the dashboard into ../docs for GitHub Pages.
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: { outDir: "../docs", emptyOutDir: true },
});
