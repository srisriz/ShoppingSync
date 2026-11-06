import { redirect } from "next/navigation";

/** The demo now lives on the Use me page, alongside how to set it up. */
export default function DemoPage() {
  redirect("/use-me#try");
}
