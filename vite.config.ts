/* Copyright (c) 2025 Loren Bian
  Licensed under the MIT License. See LICENSE file in the project root. */
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: { port: 5173 },
});
