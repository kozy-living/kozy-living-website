"use client";

import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { pillowTalkPath } from "@/lib/site";

const sessionKey = "kozy:pillow-talk-popup-seen";

export default function PillowTalkPopup() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (sessionStorage.getItem(sessionKey)) return;
        sessionStorage.setItem(sessionKey, "1");
      } catch {
        // The campaign remains available when storage is blocked.
      }
      setIsOpen(true);
    }, 3500);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Dialog open={isOpen} onClose={() => setIsOpen(false)} className="relative z-[100]">
      <div className="fixed inset-0 bg-black/55" aria-hidden="true" />
      <div className="fixed inset-0 grid place-items-center p-4">
        <DialogPanel className="relative isolate aspect-square w-full max-w-[min(34rem,calc(100dvh-2rem))] overflow-hidden rounded-plate bg-card">
          <DialogTitle className="sr-only">Pillow Talk Holiday Kapsule Kollection</DialogTitle>
          <Link href={pillowTalkPath} className="absolute inset-0 block focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4" onClick={() => setIsOpen(false)}>
            <Image
              src="/media/pillow-talk-popup.webp"
              alt="Pillow Talk Holiday Kapsule Kollection. Shop the Sleepover Set."
              fill
              sizes="(max-width: 560px) 94vw, 544px"
              className="object-contain"
            />
          </Link>
          <button
            type="button"
            aria-label="Close Pillow Talk popup"
            data-autofocus
            className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full bg-white text-2xl leading-none text-ink"
            onClick={() => setIsOpen(false)}
          >
            <span aria-hidden>×</span>
          </button>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
