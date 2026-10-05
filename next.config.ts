import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["exceljs"],
  outputFileTracingIncludes: {
    "/api/ocr/*": [
      "./node_modules/tesseract.js/dist/worker.min.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm",
      "./node_modules/@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz",
      "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
