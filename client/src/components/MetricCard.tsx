import React from 'react';

interface MetricCardProps {
  label: string;
  value: string;
  icon: string;
  sub?: string;
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, icon, sub }) => {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <div className="metric-info">
        <span className="metric-value">{value}</span>
        <span className="metric-label">{label}</span>
        {sub && <span className="metric-sub">{sub}</span>}
      </div>
    </div>
  );
};

export default MetricCard;
