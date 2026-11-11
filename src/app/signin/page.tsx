import type { Metadata } from "next";
import { SignIn } from "@/components/SignIn";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Ichnora to keep your conversations, personal memory, open loops and research history.",
};

export default function SignInPage() {
  return <SignIn />;
}
