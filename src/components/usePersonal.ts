"use client";

import { useCallback, useEffect, useState } from "react";
import { api, userTimeZone } from "./api";
import type { PersonalPatch, PersonalResponse } from "./types";

/** Loads /api/personal (memories + open loops); corrections re-fetch the feed. */
export function usePersonal(ws: string, refreshKey: number) {
  const [data, setData] = useState<PersonalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .personal(ws, userTimeZone())
      .then((r) => {
        if (!live) return;
        setData(r);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ws, refreshKey, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  const patch = useCallback(
    async (id: string, p: PersonalPatch) => {
      try {
        await api.patchPersonal(ws, id, p);
      } catch (e) {
        setError((e as Error).message);
      }
      reload();
    },
    [ws, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deletePersonal(ws, id);
      } catch (e) {
        setError((e as Error).message);
      }
      reload();
    },
    [ws, reload],
  );

  return { data, error, patch, remove, reload };
}
