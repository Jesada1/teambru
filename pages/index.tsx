import dynamic from "next/dynamic";

/**
 * Client-only App shell — avoids SSR hydration / vendor-chunk 404s from
 * browser APIs (xlsx downloads, localStorage, window.print).
 */
const App = dynamic(() => import("../App"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fafafa",
        color: "#52525b",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        fontSize: 14,
      }}
    >
      Loading timetable…
    </div>
  ),
});

export default function HomePage() {
  return <App />;
}
