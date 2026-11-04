"use client";
import { ChangeEvent } from "react";

/** File picker that refuses oversized files in the browser, before the upload is sent. */
export function FileInput({ name, accept, maxMb, required }: { name: string; accept: string; maxMb: number; required?: boolean }) {
  function check(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const f = input.files?.[0];
    const tooBig = !!f && f.size > maxMb * 1024 * 1024;
    input.setCustomValidity(tooBig ? `This file is ${(f!.size / 1048576).toFixed(1)} MB. The limit is ${maxMb} MB. For a large scan, save the PDF at a reduced size and try again.` : "");
    if (tooBig) input.reportValidity();
  }
  return <input type="file" name={name} accept={accept} required={required} onChange={check} />;
}
