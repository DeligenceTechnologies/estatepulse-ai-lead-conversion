import React, { useState } from 'react';
import { X, UserPlus, Sparkles, Building2, Phone, Mail, DollarSign, MapPin } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { LeadSource } from '../../types';

interface NewLeadModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NewLeadModal: React.FC<NewLeadModalProps> = ({ isOpen, onClose }) => {
  const { createLead, setSelectedLeadId, startLiveCallSimulation } = useApp();

  const [firstName, setFirstName] = useState('Jessica');
  const [lastName, setLastName] = useState('Taylor');
  const [phone, setPhone] = useState('+1 (512) 555-0188');
  const [email, setEmail] = useState('jessica.taylor@gmail.com');
  const [location, setLocation] = useState('North Austin / Cedar Park');
  const [budgetMin, setBudgetMin] = useState(550000);
  const [budgetMax, setBudgetMax] = useState(700000);
  const [source, setSource] = useState<LeadSource>('facebook');
  const [timeline, setTimeline] = useState('1-3 months');
  const [autoDispatch, setAutoDispatch] = useState(true);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const newLead = createLead({
      firstName,
      lastName,
      phone,
      email,
      preferredLocation: location,
      budgetMin: Number(budgetMin),
      budgetMax: Number(budgetMax),
      source,
      timeline,
      propertyType: 'Single Family Home',
      bedrooms: 4,
    }, autoDispatch);

    onClose();
    setSelectedLeadId(newLead.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100">
        
        {/* Header */}
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <UserPlus className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Create / Ingest Inbound Lead</h3>
              <p className="text-xs text-slate-400">Simulate lead arrival from ad campaigns or manual entry</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">First Name</label>
              <input
                type="text"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Last Name</label>
              <input
                type="text"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-semibold mb-1 flex items-center gap-1">
                <Phone className="w-3 h-3 text-slate-400" /> Phone Number
              </label>
              <input
                type="text"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1 flex items-center gap-1">
                <Mail className="w-3 h-3 text-slate-400" /> Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-semibold mb-1 flex items-center gap-1">
                <MapPin className="w-3 h-3 text-slate-400" /> Target Location
              </label>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Lead Source</label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
              >
                <option value="facebook">Meta / Facebook Lead Ad</option>
                <option value="zillow">Zillow Premier Agent</option>
                <option value="website">Brokerage Website Form</option>
                <option value="google">Google PPC Form</option>
                <option value="manual">Manual Entry</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-semibold mb-1 flex items-center gap-1">
                <DollarSign className="w-3 h-3 text-emerald-400" /> Budget Min
              </label>
              <input
                type="number"
                step="25000"
                value={budgetMin}
                onChange={(e) => setBudgetMin(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1 flex items-center gap-1">
                <DollarSign className="w-3 h-3 text-emerald-400" /> Budget Max
              </label>
              <input
                type="number"
                step="25000"
                value={budgetMax}
                onChange={(e) => setBudgetMax(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono"
              />
            </div>
          </div>

          {/* Auto-response toggle */}
          <div className="bg-slate-950/80 border border-slate-800 p-3 rounded-xl flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                Trigger Strategy B Instant Response
              </span>
              <p className="text-2xs text-slate-400">Instantly fires introductory SMS & dispatches Retell Voice AI</p>
            </div>
            <input
              type="checkbox"
              checked={autoDispatch}
              onChange={(e) => setAutoDispatch(e.target.checked)}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg text-xs font-bold shadow-md shadow-emerald-950 transition-colors cursor-pointer"
            >
              Create Lead & Ingest
            </button>
          </div>
        </form>

      </div>
    </div>
  );
};
