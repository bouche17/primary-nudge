import { Link } from "react-router-dom";
import { Sparkles, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

const Privacy = () => {
  return (
    <div className="min-h-screen bg-background">
      <nav className="flex items-center gap-3 px-6 py-4 border-b border-border">
        <Link to="/">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-display font-bold text-foreground">Monty</span>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-display font-black text-foreground mb-8">Privacy Policy</h1>

        <div className="prose prose-sm text-foreground/90 space-y-6">
          <section>
            <h2 className="font-display font-bold text-xl text-foreground">What data we collect</h2>
            <p className="text-muted-foreground leading-relaxed">
              When you sign up for Monty, we collect your <strong>email address</strong> for authentication. During onboarding, we collect your <strong>children's first names</strong> and <strong>year groups</strong> to personalise reminders. We also store which <strong>school</strong> each child attends.
            </p>
          </section>

          <section>
            <h2 className="font-display font-bold text-xl text-foreground">Why we collect it</h2>
            <p className="text-muted-foreground leading-relaxed">
              We use this data solely to send you timely, relevant reminders about events and dates at your child's school. We do not sell, share, or use your data for advertising.
            </p>
          </section>

          <section>
            <h2 className="font-display font-bold text-xl text-foreground">How we store it</h2>
            <p className="text-muted-foreground leading-relaxed">
              Your data is stored securely using industry-standard encryption. Access to your data is restricted to you via your authenticated account. We use Row Level Security to ensure parents can only see their own children's data.
            </p>
          </section>

          <section>
            <h2 className="font-display font-bold text-xl text-foreground">Your rights</h2>
            <p className="text-muted-foreground leading-relaxed">
              Under UK GDPR, you have the right to:
            </p>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside">
              <li><strong>Access</strong> your data — use the data export feature in Settings</li>
              <li><strong>Rectify</strong> inaccurate data — edit your children's details anytime</li>
              <li><strong>Delete</strong> your data — use the account deletion feature in Settings</li>
              <li><strong>Withdraw consent</strong> — delete your account at any time</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display font-bold text-xl text-foreground">Children's data</h2>
            <p className="text-muted-foreground leading-relaxed">
              We take special care with children's data. We only collect first names and year groups — the minimum needed to provide personalised reminders. We do not collect dates of birth, surnames, or any other identifying information about children.
            </p>
          </section>

          <section>
            <h2 className="font-display font-bold text-xl text-foreground">Data retention</h2>
            <p className="text-muted-foreground leading-relaxed">
              Your data is retained as long as your account is active. When you delete your account, all associated data (children, consent records) is permanently deleted immediately.
            </p>
          </section>

          <section>
            <h2 className="font-display font-bold text-xl text-foreground">Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you have any questions about this privacy policy or your data, please contact us at{" "}
              <a href="mailto:privacy@monty.app" className="text-primary underline hover:no-underline">
                privacy@monty.app
              </a>.
            </p>
          </section>

          <p className="text-xs text-muted-foreground pt-4 border-t border-border">
            Last updated: February 2026
          </p>
        </div>
      </main>
    </div>
  );
};

export default Privacy;
