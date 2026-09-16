/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#070604",
        card: "#0D0C07",
        edge: "#2E2A16",
        edgeDark: "#2E2A16",
        ink: "#F2EFE0",
        mute: "#A09C88",
        faint: "#6E6A56",
        brand: {
          DEFAULT: "#FFD400",
          soft: "#161408",
          hover: "#E6BF00",
        },
        jade: {
          DEFAULT: "#FFD400",
          soft: "#161408",
          hover: "#E6BF00",
        },
        violet: {
          DEFAULT: "#A68A00",
          soft: "#161408",
          hover: "#8A7200",
        },
        rise: "#FF4A3D",
        fall: "#A09C88",
      },
      fontFamily: {
        serif: ['"Noto Serif SC"', '"Songti SC"', "STSong", "serif"],
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          "sans-serif",
        ],
        mono: ['"SF Mono"', "Menlo", "Consolas", '"Liberation Mono"', "monospace"],
      },
      borderRadius: {
        card: "0px",
      },
      boxShadow: {
        card: "none",
        pop: "none",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        fadeUp: {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
      },
      animation: {
        blink: "blink 1s step-end infinite",
        fadeUp: "fadeUp .28s ease-out both",
        shimmer: "shimmer 1.4s linear infinite",
      },
    },
  },
  plugins: [],
};
