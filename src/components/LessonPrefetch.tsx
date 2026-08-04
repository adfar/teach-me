"use client";

import { useEffect, useRef } from "react";

export function LessonPrefetch({
  nextLessonId,
}: {
  nextLessonId: string | null;
}) {
  const requestedLessonId = useRef<string | null>(null);

  useEffect(() => {
    if (!nextLessonId || requestedLessonId.current === nextLessonId) return;
    requestedLessonId.current = nextLessonId;

    void fetch(`/api/lessons/${nextLessonId}/generate`, {
      method: "POST",
    }).catch(() => undefined);
  }, [nextLessonId]);

  return null;
}
