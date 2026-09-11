import React, { useState } from 'react';
import { 
  Search, 
  Send, 
  UserCheck, 
  Pause, 
  Play, 
  Phone, 
  Sparkles, 
  Clock, 
  CheckCircle2, 
  Calendar,
  Flame
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

export const ConversationsView: React.FC = () => {
  const { 
    leads, 
    conversations, 
    sendSmsMessage, 
    takeOverConversation, 
    toggleAutomation, 
    startLiveCallSimulation,
    setSelectedLeadId,
    orgSettings 
  } = useApp();

  const [selectedLeadIdLocal, setSelectedLeadIdLocal] = useState<string>(leads[0]?.id || '');
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const currentLead = leads.find(l => l.id === selectedLeadIdLocal) || leads[0];
  const currentConversation = currentLead ? conversations[currentLead.id] : undefined;

  const filteredLeads = leads.filter(l => {
    const q = searchQuery.toLowerCase();
    return `${l.firstName} ${l.lastName}`.toLowerCase().includes(q) || l.phone.includes(q);
  });

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !currentLead) return;
    sendSmsMessage(currentLead.id, inputText.trim(), 'agent');
    setInputText('');
  };

  const cannedReplies = [
    "Would tomorrow at 10:00 AM work for a quick introductory video call?",
    "We have 3 off-market listings in North Austin matching your $500k-$650k budget.",
    "Would it be helpful if we introduced you to our trusted local lender for pre-approval?",
    "Can you confirm if you prefer single family homes or are open to townhomes?"
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto h-[calc(100vh-5rem)] flex flex-col text-slate-100">
      
      {/* Top Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Omnichannel Conversations</h2>
          <p className="text-xs text-slate-400">Unified Twilio SMS, voice transcripts, and live human agent takeover</p>
        </div>
        <div className="text-xs text-slate-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>Active Assistant: <strong className="text-white">{orgSettings.aiAgentName}</strong></span>
        </div>
      </div>

      {/* Main Split Pane Layout */}
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-12 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        
        {/* Left Pane: Conversation Threads List */}
        <div className="md:col-span-4 border-r border-slate-800 flex flex-col bg-slate-950/60">
          <div className="p-3 border-b border-slate-800">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search conversations..."
                className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 custom-scrollbar">
            {filteredLeads.map(lead => {
              const conv = conversations[lead.id];
              const lastMsg = conv?.messages[conv.messages.length - 1];
              const isSelected = lead.id === currentLead?.id;

              return (
                <div
                  key={lead.id}
                  onClick={() => setSelectedLeadIdLocal(lead.id)}
                  className={`p-3 transition-colors cursor-pointer flex items-start justify-between gap-2 ${
                    isSelected ? 'bg-slate-800/80 border-l-2 border-emerald-500' : 'hover:bg-slate-800/30'
                  }`}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-xs text-slate-100 truncate">
                        {lead.firstName} {lead.lastName}
                      </span>
                      {lead.temperature === 'hot' && (
                        <span className="text-[10px] font-bold text-rose-400">🔥</span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 truncate">
                      {lastMsg ? lastMsg.content : 'No messages logged yet'}
                    </p>
                  </div>

                  <span className="text-[10px] text-slate-500 font-mono shrink-0">
                    {lastMsg ? new Date(lastMsg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Pane: Active Message Thread */}
        {currentLead ? (
          <div className="md:col-span-8 flex flex-col h-full bg-slate-900">
            
            {/* Thread Header */}
            <div className="p-3.5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-slate-800 text-white font-bold text-sm flex items-center justify-center">
                  {currentLead.firstName[0]}{currentLead.lastName[0]}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-bold text-white">
                      {currentLead.firstName} {currentLead.lastName}
                    </h3>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                      {currentLead.phone}
                    </span>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.2 rounded-full ${
                      currentLead.temperature === 'hot' ? 'bg-rose-500/20 text-rose-300' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {currentLead.temperature} ({currentLead.score})
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Budget: ${(currentLead.budgetMin/1000).toFixed(0)}k–${(currentLead.budgetMax/1000).toFixed(0)}k • {currentLead.preferredLocation}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => startLiveCallSimulation(currentLead)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Phone className="w-3.5 h-3.5" />
                  <span>AI Voice Call</span>
                </button>

                <button
                  onClick={() => takeOverConversation(currentLead.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                    currentLead.status === 'human_handoff' 
                      ? 'bg-amber-950 text-amber-300 border-amber-700/60' 
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                  }`}
                >
                  <UserCheck className="w-3.5 h-3.5 inline mr-1" />
                  <span>{currentLead.status === 'human_handoff' ? 'Human Active' : 'Take Over'}</span>
                </button>
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
              {currentConversation && currentConversation.messages.length > 0 ? (
                currentConversation.messages.map(msg => {
                  const isLead = msg.sender === 'lead';
                  const isAi = msg.sender === 'ai';
                  return (
                    <div key={msg.id} className={`flex flex-col ${isLead ? 'items-start' : 'items-end'}`}>
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mb-0.5 px-1">
                        <span className="font-semibold text-slate-300">
                          {isAi ? `${orgSettings.aiAgentName} (AI Assistant)` : isLead ? `${currentLead.firstName} ${currentLead.lastName}` : 'Agent (You)'}
                        </span>
                        <span>•</span>
                        <span>{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className={`p-3 rounded-2xl max-w-[75%] text-xs leading-relaxed ${
                        isLead 
                          ? 'bg-slate-800 text-slate-100 rounded-tl-sm border border-slate-700' 
                          : isAi 
                          ? 'bg-emerald-950/80 text-emerald-200 border border-emerald-800/60 rounded-tr-sm' 
                          : 'bg-emerald-600 text-white rounded-tr-sm shadow-md'
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-slate-500">
                  No message history for this lead.
                </div>
              )}
            </div>

            {/* Canned Quick Actions */}
            <div className="px-4 py-2 border-t border-slate-800/80 bg-slate-950/40 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <span className="text-[10px] text-slate-400 uppercase font-semibold shrink-0">Quick Replies:</span>
              {cannedReplies.map((reply, i) => (
                <button
                  key={i}
                  onClick={() => setInputText(reply)}
                  className="text-[11px] px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/60 transition-colors whitespace-nowrap cursor-pointer"
                >
                  {reply.substring(0, 38)}...
                </button>
              ))}
            </div>

            {/* Input Form */}
            <form onSubmit={handleSendMessage} className="p-3 bg-slate-950 border-t border-slate-800 flex items-center gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={`Type SMS message to ${currentLead.firstName}...`}
                className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={!inputText.trim()}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Send SMS</span>
              </button>
            </form>

          </div>
        ) : (
          <div className="md:col-span-8 flex items-center justify-center text-xs text-slate-500">
            Select a conversation on the left.
          </div>
        )}

      </div>
    </div>
  );
};
