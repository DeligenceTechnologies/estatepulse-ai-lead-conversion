import React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Building2,
  PhoneCall,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Webhook,
  Zap,
} from 'lucide-react';

/**
 * The public home page, shown at `/` to anyone who is not signed in.
 *
 * Deliberately claims only what the product actually does today: lead capture
 * from real webhook sources, an AI qualification call, and handoff to an agent.
 * There are no invented metrics, testimonials, customer logos or pricing on this
 * page — putting a number like "3x more conversions" here would be inventing
 * product behaviour, and it would be the first thing a prospect asks about.
 *
 * Visual language is AuthLayout's, so arriving here and then hitting Sign in
 * does not feel like two different products.
 */

const STEPS: Array<{ title: string; body: string; icon: React.ReactNode }> = [
  {
    title: 'A lead arrives',
    body: 'Your website form, portal or CRM posts straight into EstatePulse over a live webhook. Nothing is typed in by hand.',
    icon: <Webhook className="w-5 h-5" />,
  },
  {
    title: 'The AI calls and qualifies',
    body: 'An AI voice call goes out and asks the things that matter: budget, area, timeline and why they are moving.',
    icon: <PhoneCall className="w-5 h-5" />,
  },
  {
    title: 'The right agent takes over',
    body: 'Qualified leads are handed to an agent who covers that area and has room to take them, with the call summary attached.',
    icon: <UserCheck className="w-5 h-5" />,
  },
];

const FEATURES: Array<{ title: string; body: string; icon: React.ReactNode }> = [
  {
    title: 'Live lead sources',
    body: 'Connect the forms you already use. Every delivery is logged, so you can see exactly what arrived and when.',
    icon: <Webhook className="w-4 h-4" />,
  },
  {
    title: 'AI qualification calls',
    body: 'Budget, preferred area, timeline and motivation captured on the call and written to the lead record.',
    icon: <Sparkles className="w-4 h-4" />,
  },
  {
    title: 'Your agent roster',
    body: 'Add agents, set their territories, working hours and how many live leads each one should carry.',
    icon: <Building2 className="w-4 h-4" />,
  },
  {
    title: 'Routing you can audit',
    body: 'Every assignment records why that agent was chosen — and an unassigned lead always shows the reason.',
    icon: <UserCheck className="w-4 h-4" />,
  },
  {
    title: 'One office, one set of data',
    body: 'Each organization is isolated at the database level. An agent only ever sees the leads assigned to them.',
    icon: <ShieldCheck className="w-4 h-4" />,
  },
  {
    title: 'Built for handoff, not dashboards',
    body: 'The product exists to get a real person on the phone with a real buyer. Everything else serves that.',
    icon: <PhoneCall className="w-4 h-4" />,
  },
];

const Brand: React.FC = () => (
  <div className="flex items-center gap-2.5">
    <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
      <Zap className="w-5 h-5 text-white" />
    </div>
    <span className="text-lg font-bold tracking-tight text-slate-100">EstatePulse AI</span>
  </div>
);

export const LandingPage: React.FC = () => (
  <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-emerald-500 selection:text-white">
    <header className="border-b border-slate-800/70">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
        <Brand />
        <nav className="flex items-center gap-2 sm:gap-3">
          <Link
            to="/login"
            className="px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold text-slate-300 hover:text-slate-100 hover:bg-slate-900 transition-colors"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            className="px-3 sm:px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-colors"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>

    {/* Hero */}
    <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-16 pb-14 sm:pt-24 sm:pb-20">
      <div className="max-w-3xl space-y-6">
        <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
          <Sparkles className="w-3 h-3" />
          Lead conversion for real estate teams
        </span>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white tracking-tight leading-[1.1]">
          Every inbound lead gets a call.
          <span className="block text-emerald-400">Not a queue.</span>
        </h1>

        <p className="text-base sm:text-lg text-slate-400 leading-relaxed max-w-2xl">
          EstatePulse answers new leads with an AI voice call, finds out what they actually want,
          and hands the serious ones to the agent who covers that area — while they are still
          interested.
        </p>

        <div className="pt-2">
          <Link
            to="/signup"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold shadow-lg shadow-emerald-950/50 transition-colors"
          >
            Create your organization
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>

    {/* How it works */}
    <section id="how-it-works" className="border-y border-slate-800/70 bg-slate-900/30 scroll-mt-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20 space-y-10">
        <div className="space-y-2">
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">How it works</h2>
          <p className="text-sm text-slate-400">Three steps, and none of them are manual.</p>
        </div>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 space-y-3 shadow-xl"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="w-10 h-10 rounded-xl bg-emerald-600/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center">
                  {step.icon}
                </span>
                <span className="text-3xl font-extrabold text-slate-800 font-mono leading-none">
                  {i + 1}
                </span>
              </div>
              <h3 className="text-base font-bold text-white">{step.title}</h3>
              <p className="text-xs text-slate-400 leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>

    {/* Features */}
    <section
      id="features"
      className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20 space-y-10 scroll-mt-16"
    >
      <div className="space-y-2">
        <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
          What you get
        </h2>
        <p className="text-sm text-slate-400">
          The parts of the platform that are live today.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-2.5 hover:border-slate-700 transition-colors"
          >
            <span className="w-9 h-9 rounded-xl bg-slate-800 border border-slate-700/60 text-emerald-400 flex items-center justify-center">
              {f.icon}
            </span>
            <h3 className="text-sm font-bold text-white">{f.title}</h3>
            <p className="text-xs text-slate-400 leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
    </section>

    {/* Closing call to action */}
    <section className="border-t border-slate-800/70 bg-slate-900/30">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20">
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-8 sm:p-10 text-center space-y-5 shadow-xl">
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Set up your office in a few minutes
          </h2>
          <p className="text-sm text-slate-400 max-w-xl mx-auto leading-relaxed">
            Create an organization, connect the form your leads already come through, and add your
            agents. Nothing to install.
          </p>
          <Link
            to="/signup"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold shadow-lg shadow-emerald-950/50 transition-colors"
          >
            Get started
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>

    {/* Every link here goes somewhere that exists: two real routes and two
        sections of this page. No Privacy/Terms/social links — those would be
        dead ends until the pages behind them are actually written. */}
    <footer className="border-t border-slate-800/70 bg-slate-950">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-2 space-y-3">
            <Brand />
            <p className="text-xs text-slate-500 leading-relaxed max-w-xs">
              Lead conversion for real estate teams. Inbound leads are called, qualified and handed
              to the right agent automatically.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="text-[11px] uppercase tracking-wider font-bold text-slate-300">
              Product
            </h3>
            <ul className="space-y-2 text-xs text-slate-500">
              <li>
                <a href="#how-it-works" className="hover:text-slate-300 transition-colors">
                  How it works
                </a>
              </li>
              <li>
                <a href="#features" className="hover:text-slate-300 transition-colors">
                  What you get
                </a>
              </li>
            </ul>
          </div>

          <div className="space-y-3">
            <h3 className="text-[11px] uppercase tracking-wider font-bold text-slate-300">
              Account
            </h3>
            <ul className="space-y-2 text-xs text-slate-500">
              <li>
                <Link to="/signup" className="hover:text-slate-300 transition-colors">
                  Create your organization
                </Link>
              </li>
              <li>
                <Link to="/login" className="hover:text-slate-300 transition-colors">
                  Sign in
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-slate-800/70 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-[11px] text-slate-600">
            © {new Date().getFullYear()} EstatePulse AI. All rights reserved.
          </p>
          <p className="text-[11px] text-slate-600">Built for real estate teams.</p>
        </div>
      </div>
    </footer>
  </div>
);
