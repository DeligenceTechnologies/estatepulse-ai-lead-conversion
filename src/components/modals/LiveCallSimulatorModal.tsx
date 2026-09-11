import React, { useState, useEffect, useRef } from 'react';
import { 
  Phone, 
  PhoneOff, 
  Mic, 
  MicOff, 
  Volume2, 
  VolumeX, 
  Sparkles, 
  ShieldCheck, 
  Calendar, 
  CheckCircle2, 
  Clock, 
  Send,
  Building2,
  Flame,
  ArrowRight
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { TranscriptTurn, CallRecord } from '../../types';

export const LiveCallSimulatorModal: React.FC = () => {
  const {
    isSimulatingCall,
    activeSimulatedLead,
    closeLiveCallSimulation,
    orgSettings,
    agents,
    bookAppointment,
    simulateHotQualification,
    updateLead
  } = useApp();

  const [callDuration, setCallDuration] = useState(0);
  const [callStatus, setCallStatus] = useState<'ringing' | 'connected' | 'completed'>('ringing');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [micActive, setMicActive] = useState(false);
  const [userInput, setUserInput] = useState('');
  
  // Real-time extracted data during call
  const [extractedTimeline, setExtractedTimeline] = useState<string | null>(null);
  const [extractedBudget, setExtractedBudget] = useState<string | null>(null);
  const [extractedLocation, setExtractedLocation] = useState<string | null>(null);
  const [extractedFinancing, setExtractedFinancing] = useState<string | null>(null);
  const [liveScore, setLiveScore] = useState(45);

  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const lead = activeSimulatedLead;

  // Speak AI text via Web Speech API if enabled
  const speakText = (text: string) => {
    if (!soundEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    // Choose a friendly English voice if available
    const voices = window.speechSynthesis.getVoices();
    const naturalVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Alex')));
    if (naturalVoice) utterance.voice = naturalVoice;
    window.speechSynthesis.speak(utterance);
  };

  // Start call lifecycle
  useEffect(() => {
    if (!isSimulatingCall || !lead) return;

    setCallStatus('ringing');
    setCallDuration(0);
    setLiveScore(45);
    setExtractedTimeline(null);
    setExtractedBudget(null);
    setExtractedLocation(null);
    setExtractedFinancing(null);

    // Initial greeting after 1.5s
    const timer = setTimeout(() => {
      setCallStatus('connected');
      const initialGreeting = `Hello, this is ${orgSettings.aiAgentName} calling from ${orgSettings.name}. Am I speaking with ${lead.firstName}?`;
      setTranscript([
        { speaker: 'AI (Alex)', timestamp: '0:02', text: initialGreeting }
      ]);
      speakText(initialGreeting);
    }, 1500);

    return () => {
      clearTimeout(timer);
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [isSimulatingCall, lead]);

  // Duration timer
  useEffect(() => {
    if (callStatus !== 'connected') return;
    const interval = setInterval(() => {
      setCallDuration(d => d + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [callStatus]);

  // Scroll to bottom on new message
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  if (!isSimulatingCall || !lead) return null;

  const formatSeconds = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const handleSendLeadResponse = (textToSend: string) => {
    if (!textToSend.trim()) return;

    const currentTimestamp = formatSeconds(callDuration);
    const newTurn: TranscriptTurn = {
      speaker: 'Lead',
      timestamp: currentTimestamp,
      text: textToSend.trim(),
    };

    setTranscript(prev => [...prev, newTurn]);
    setUserInput('');

    // Trigger AI smart contextual response
    setTimeout(() => {
      processAiAnswer(textToSend.trim());
    }, 1200);
  };

  const processAiAnswer = (leadUtterance: string) => {
    const lower = leadUtterance.toLowerCase();
    let aiResponse = "";

    if (lower.includes('speaking') || lower.includes('yes') || lower.includes('hi') || lower.includes('hello')) {
      aiResponse = `Great to connect with you, ${lead.firstName}! I noticed your inquiry about homes in ${lead.preferredLocation}. What kind of property are you envisioning and when are you looking to move?`;
    } else if (lower.includes('month') || lower.includes('soon') || lower.includes('relocat') || lower.includes('bedroom') || lower.includes('dallas')) {
      setExtractedTimeline('1-3 Months (Relocating)');
      setExtractedLocation('North Austin / Round Rock');
      setLiveScore(68);
      aiResponse = `Moving within a couple months is a great window to get ahead of the market! North Austin and Round Rock offer wonderful school districts. What price point feels most comfortable for your family?`;
    } else if (lower.includes('budget') || lower.includes('500') || lower.includes('650') || lower.includes('$') || lower.includes('thousand')) {
      setExtractedBudget('$500,000 – $650,000');
      setLiveScore(82);
      aiResponse = `That budget gives you plenty of strong options for a 4-bedroom home with a yard in those neighborhoods. Have you already secured a mortgage pre-approval, or would you like us to connect you with our preferred lender?`;
    } else if (lower.includes('lender') || lower.includes('pre-approv') || lower.includes('need') || lower.includes('not yet')) {
      setExtractedFinancing('Needs preferred lender intro');
      setLiveScore(89);
      aiResponse = `We can definitely make that introduction to our top-rated local lender who can turn around pre-approval within 24 hours. Would you be open to a 15-minute consultation with our team lead Alex tomorrow morning at 10:00 AM to review matching off-market listings?`;
    } else if (lower.includes('tomorrow') || lower.includes('10') || lower.includes('works') || lower.includes('great') || lower.includes('sure')) {
      aiResponse = `Wonderful! I have locked in that appointment for 10:00 AM tomorrow. You'll receive a confirmation text and calendar invite right now. Looking forward to helping you find your new home, ${lead.firstName}!`;
      setTimeout(() => {
        handleCompleteCallAndBook();
      }, 2500);
    } else {
      aiResponse = `Got it, that is very helpful context. We have several off-market listings matching that exact profile. Would tomorrow at 10:00 AM work for a quick introductory video or phone consultation?`;
    }

    const aiTurn: TranscriptTurn = {
      speaker: 'AI (Alex)',
      timestamp: formatSeconds(callDuration + 1),
      text: aiResponse,
    };

    setTranscript(prev => [...prev, aiTurn]);
    speakText(aiResponse);
  };

  const handleCompleteCallAndBook = () => {
    simulateHotQualification(lead.id);

    // Book appointment for tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);

    const assignedAgent = agents.find(a => a.id === lead.assignedAgentId) || agents[0];

    bookAppointment({
      organizationId: orgSettings.id,
      leadId: lead.id,
      leadName: `${lead.firstName} ${lead.lastName}`,
      agentId: lead.assignedAgentId,
      agentName: assignedAgent.name,
      provider: 'calendly',
      startTime: tomorrow.toISOString(),
      endTime: new Date(tomorrow.getTime() + 30 * 60000).toISOString(),
      status: 'scheduled',
      appointmentType: 'Buyer Consultation',
      locationOrLink: 'https://meet.google.com/aus-home-consult',
      notes: 'Consultation booked via live Retell Voice AI interaction.',
    });

    setCallStatus('completed');
  };

  const quickResponses = [
    "Yes, this is Sarah! We are relocating from Dallas and want to buy within 2 months.",
    "We need 4 bedrooms with a budget between $500k and $650k max.",
    "We definitely need a lender connection. We haven't done pre-approval yet.",
    "Yes, tomorrow at 10 AM works great for a consultation call!"
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Top Header: Voice Call State */}
        <div className="p-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white ${
              callStatus === 'connected' ? 'bg-emerald-600 animate-pulse' : callStatus === 'ringing' ? 'bg-amber-600 animate-bounce' : 'bg-slate-700'
            }`}>
              <Phone className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/50">
                  Retell AI Voice Engine
                </span>
                <span className="text-xs text-slate-400">
                  {callStatus === 'ringing' && 'Dialing Lead Phone...'}
                  {callStatus === 'connected' && `Call in Progress • ${formatSeconds(callDuration)}`}
                  {callStatus === 'completed' && 'Call Completed • Appointment Booked'}
                </span>
              </div>
              <h3 className="text-base font-bold text-white mt-0.5">
                Speaking with {lead.firstName} {lead.lastName} ({lead.phone})
              </h3>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`p-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                soundEnabled ? 'bg-emerald-950 text-emerald-300 border-emerald-800/60' : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
              title={soundEnabled ? 'Mute synthesized speech' : 'Enable synthesized voice'}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
            <button
              onClick={closeLiveCallSimulation}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              <PhoneOff className="w-4 h-4 text-rose-400" />
            </button>
          </div>
        </div>

        {/* Main Body: Two Columns (Transcript Left, Extraction & Score Right) */}
        <div className="grid grid-cols-1 md:grid-cols-12 flex-1 min-h-0 divide-y md:divide-y-0 md:divide-x divide-slate-800">
          
          {/* Left: Live Transcript Thread & Interactive Responses */}
          <div className="md:col-span-7 flex flex-col p-4 bg-slate-900/60 min-h-[360px] max-h-[500px]">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
              <span>Live Conversation Transcript</span>
              {callStatus === 'connected' && (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                  <span>Streaming Audio</span>
                </div>
              )}
            </div>

            {/* Scrollable Transcript */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
              {transcript.map((turn, index) => {
                const isAi = turn.speaker.includes('AI');
                return (
                  <div key={index} className={`flex flex-col ${isAi ? 'items-start' : 'items-end'}`}>
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mb-0.5 px-1">
                      <span className="font-semibold text-slate-300">{turn.speaker}</span>
                      <span>•</span>
                      <span>{turn.timestamp}</span>
                    </div>
                    <div className={`p-3 rounded-2xl max-w-[85%] text-xs leading-relaxed ${
                      isAi 
                        ? 'bg-slate-800/90 text-slate-100 border border-slate-700/60 rounded-tl-sm' 
                        : 'bg-emerald-600 text-white rounded-tr-sm shadow-md shadow-emerald-950/40'
                    }`}>
                      {turn.text}
                    </div>
                  </div>
                );
              })}
              <div ref={transcriptEndRef} />
            </div>

            {/* Quick Prompts to Advance the Demo */}
            {callStatus === 'connected' && (
              <div className="pt-3 border-t border-slate-800 space-y-2">
                <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  <span>Click a response or type to test AI qualification:</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {quickResponses.map((qr, i) => (
                    <button
                      key={i}
                      onClick={() => handleSendLeadResponse(qr)}
                      className="text-[11px] text-left px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/70 transition-colors cursor-pointer truncate max-w-full"
                    >
                      {qr}
                    </button>
                  ))}
                </div>

                {/* Custom Input */}
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendLeadResponse(userInput);
                  }}
                  className="flex items-center gap-2 pt-1"
                >
                  <input
                    type="text"
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    placeholder="Speak/type as the lead..."
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                  <button
                    type="submit"
                    disabled={!userInput.trim()}
                    className="p-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg transition-colors cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                </form>
              </div>
            )}

            {/* Completed Banner */}
            {callStatus === 'completed' && (
              <div className="mt-3 p-3 bg-emerald-950/60 border border-emerald-600/40 rounded-xl text-xs text-emerald-300 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Consultation Booked for 10:00 AM Tomorrow! CRM & Agent notified.</span>
                </div>
                <button
                  onClick={closeLiveCallSimulation}
                  className="px-3 py-1 bg-emerald-600 text-white text-[11px] font-semibold rounded-lg hover:bg-emerald-500 transition-colors"
                >
                  View Lead in Dashboard
                </button>
              </div>
            )}
          </div>

          {/* Right: Real-time Structured Extraction & Lead Score Meter */}
          <div className="md:col-span-5 p-4 bg-slate-950/40 space-y-4">
            
            {/* Dynamic Score Card */}
            <div className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Dynamic Lead Score</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  liveScore >= 75 ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40' : 'bg-amber-500/20 text-amber-300'
                }`}>
                  {liveScore >= 75 ? '🔥 HOT' : '☀️ WARM'}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-white font-mono">{liveScore}</span>
                <span className="text-xs text-slate-500">/ 100 Maximum</span>
              </div>
              {/* Progress bar */}
              <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-500 ${liveScore >= 75 ? 'bg-gradient-to-r from-amber-500 to-rose-500' : 'bg-emerald-500'}`}
                  style={{ width: `${liveScore}%` }}
                />
              </div>
            </div>

            {/* Extracted Structured Data Badges (PRD Section 25) */}
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
                <span>AI Structured Extraction (JSON)</span>
              </div>

              <div className="space-y-2 text-xs">
                <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between">
                  <span className="text-slate-400">Timeline:</span>
                  <span className="font-semibold text-slate-200">
                    {extractedTimeline || lead.timeline || 'Extracting...'}
                  </span>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between">
                  <span className="text-slate-400">Budget Range:</span>
                  <span className="font-semibold text-emerald-400 font-mono">
                    {extractedBudget || `$${(lead.budgetMin / 1000).toFixed(0)}k - $${(lead.budgetMax / 1000).toFixed(0)}k`}
                  </span>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between">
                  <span className="text-slate-400">Target Area:</span>
                  <span className="font-semibold text-slate-200">
                    {extractedLocation || lead.preferredLocation}
                  </span>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between">
                  <span className="text-slate-400">Financing:</span>
                  <span className="font-semibold text-slate-200">
                    {extractedFinancing || lead.financingStatus}
                  </span>
                </div>
              </div>
            </div>

            {/* One Click Booking / Complete Call */}
            {callStatus === 'connected' && (
              <button
                onClick={handleCompleteCallAndBook}
                className="w-full px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white text-xs font-bold shadow-lg shadow-emerald-950 flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <Calendar className="w-4 h-4" />
                <span>Lock Appointment & Finalize Score (87)</span>
              </button>
            )}

          </div>

        </div>

      </div>
    </div>
  );
};
