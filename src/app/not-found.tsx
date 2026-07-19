import Link from "next/link";

export default function NotFound() {
  return (
    <div className="reading-shell">
      <p className="eyebrow">Not found</p>
      <h1>This page isn’t in your library.</h1>
      <p>The course or lesson may no longer exist.</p>
      <Link className="back-link" href="/">← Return to the library</Link>
    </div>
  );
}
