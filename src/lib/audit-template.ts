export const getAuditEmailHtml = (stats: {
  compliance: number,
  totalTickets: number,
  vipBreaches: number
}) => `
<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
  <div style="background-color: #000; color: #fff; padding: 20px; text-align: center;">
    <h1 style="margin: 0; font-size: 20px; letter-spacing: 1px;">VIDAL ECOSYSTEM</h1>
    <p style="margin: 5px 0 0; font-size: 12px; opacity: 0.8;">AI-Powered SaaS Audit Service</p>
  </div>
  <div style="padding: 30px; line-height: 1.6; color: #333;">
    <h2 style="font-size: 18px; border-bottom: 2px solid #f0f0f0; padding-bottom: 10px;">Daily SLA Report</h2>
    <div style="display: flex; justify-content: space-between; margin: 25px 0;">
      <div style="text-align: center; flex: 1;">
        <span style="font-size: 10px; color: #888; text-transform: uppercase;">Compliance</span><br/>
        <strong style="font-size: 24px; color: ${stats.compliance >= 95 ? '#10b981' : '#ef4444'};">${stats.compliance}%</strong>
      </div>
      <div style="text-align: center; flex: 1;">
        <span style="font-size: 10px; color: #888; text-transform: uppercase;">VIP Risks</span><br/>
        <strong style="font-size: 24px; color: ${stats.vipBreaches > 0 ? '#f59e0b' : '#10b981'};">${stats.vipBreaches}</strong>
      </div>
    </div>
    <p style="font-size: 14px;">La auditoría ha analizado <strong>${stats.totalTickets}</strong> tickets activos. El rendimiento se mantiene dentro de los parámetros de cumplimiento suizos.</p>
  </div>
  <div style="background-color: #f9f9f9; padding: 15px; text-align: center; font-size: 11px; color: #999;">
    Swiss DSG Compliant | Powered by Gemini 3 Flash
  </div>
</div>
`;
