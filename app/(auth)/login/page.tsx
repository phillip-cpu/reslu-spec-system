"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (signInError) {
      setError("Incorrect email or password.");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-10 text-center">
        <Image
          src="/reslu-logo.png"
          alt="RESLU"
          width={145}
          height={64}
          priority
          className="mx-auto h-16 w-auto"
        />
        <p className="label-caps mt-4">Spec System</p>
      </div>

      <form onSubmit={handleSubmit} className="bg-offwhite border border-[#dcd6cc] p-8 space-y-5">
        <div>
          <label htmlFor="email" className="label-caps block mb-2">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body text-charcoal focus:outline-none focus:border-nearblack"
          />
        </div>

        <div>
          <label htmlFor="password" className="label-caps block mb-2">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body text-charcoal focus:outline-none focus:border-nearblack"
          />
        </div>

        {error && <p className="text-body text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-nearblack text-white py-2.5 text-subhead hover:bg-charcoal transition-colors disabled:opacity-60"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-caption text-center text-charcoal/60">
          Accounts are created by an administrator. There is no self sign-up.
        </p>
      </form>
    </div>
  );
}
