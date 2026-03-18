import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { WeekDay } from '../hooks/useWorkouts';

interface WeekChartProps {
  data: WeekDay[];
}

const WeekChart: React.FC<WeekChartProps> = ({ data }) => {
  const maxKm = Math.max(...data.map(d => d.km), 1);

  return (
    <div className="week-chart">
      <h3 className="section-title">Километраж за неделю</h3>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <XAxis
            dataKey="day"
            tick={{ fill: '#8892a4', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#8892a4', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: '#1a2235',
              border: '1px solid #2a3a52',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '13px'
            }}
            formatter={(value: number) => [`${value} км`, 'Дистанция']}
            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
          />
          <Bar dataKey="km" radius={[6, 6, 0, 0]} maxBarSize={32}>
            {data.map((entry, index) => (
              <Cell
                key={index}
                fill={entry.km > 0 ? (entry.km >= maxKm * 0.7 ? '#00d4aa' : '#3b82f6') : '#1e293b'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default WeekChart;
