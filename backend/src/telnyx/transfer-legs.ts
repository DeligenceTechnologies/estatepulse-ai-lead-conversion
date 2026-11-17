import { Injectable } from '@nestjs/common';

/** A call leg we dialed to an agent for a live transfer. */
export interface AgentLeg {
  orgId: string;
  attemptId: string;
}

/** What the live-transfer module does with call events; it registers itself here at start-up. */
export interface TransferLegHandler {
  /** The agent leg this event is about, from its client_state or its call_control_id; null when it is not one. */
  findAgentLeg(ccid: string, clientState: unknown): Promise<AgentLeg | null>;
  onAgentLegEvent(leg: AgentLeg, ccid: string, type: string, payload: any): Promise<void>;
  /** The lead's own call ended: any transfer still ringing agents for it stops. */
  onLeadHangup(ccid: string): Promise<void>;
}

/**
 * Where Telnyx call events for agent legs go. The transfer module needs lead assignment
 * (LeadModule, which imports this module), so it cannot be imported here; it registers
 * instead, and with nothing registered every event takes the usual path.
 */
@Injectable()
export class TransferLegs {
  private handler: TransferLegHandler | null = null;

  register(handler: TransferLegHandler): void {
    this.handler = handler;
  }

  findAgentLeg(ccid: string, clientState: unknown): Promise<AgentLeg | null> {
    return this.handler ? this.handler.findAgentLeg(ccid, clientState) : Promise.resolve(null);
  }

  async onAgentLegEvent(leg: AgentLeg, ccid: string, type: string, payload: any): Promise<void> {
    await this.handler?.onAgentLegEvent(leg, ccid, type, payload);
  }

  async onLeadHangup(ccid: string): Promise<void> {
    await this.handler?.onLeadHangup(ccid);
  }
}
