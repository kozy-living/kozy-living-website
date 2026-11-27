"use client";

import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import Image from "next/image";
import { useState } from "react";

export function PillowTalkSizeChart() {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(false);
  function close() { setOpen(false); setZoom(false); }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="spec-mono leading-none text-ink underline decoration-ink/30 underline-offset-4">
        Size Chart
      </button>
      <Dialog open={open} onClose={close} className="relative z-[1000]">
        <div className="fixed inset-0 bg-indigo/55" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-3 sm:p-6">
          <DialogPanel data-lenis-prevent className="flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-plate bg-paper">
            <div className="rule-b flex shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <DialogTitle className="eyebrow">Pillow Talk Size Chart</DialogTitle>
              <div className="flex items-center gap-4">
                <button type="button" aria-pressed={zoom} onClick={() => setZoom(!zoom)} className="spec-mono underline">{zoom ? "Fit image" : "Zoom in"}</button>
                <button type="button" onClick={close} aria-label="Close size chart"><XMarkIcon className="h-6 w-6" /></button>
              </div>
            </div>
            <div data-lenis-prevent className="min-h-0 flex-1 overflow-auto overscroll-contain p-2 sm:p-4">
              <Image src="/media/pillow-talk-size-chart.webp" alt="Pillow Talk adult shirt and bottom size chart, sizes S, M and L; measurements in inches." width={1248} height={1248} unoptimized className="mx-auto block h-auto max-w-none" style={{ width: zoom ? "1248px" : "100%" }} />
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </>
  );
}
