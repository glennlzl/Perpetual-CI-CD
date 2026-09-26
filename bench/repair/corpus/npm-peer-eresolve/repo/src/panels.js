/** The operations dashboard's panels, top to bottom. */
export const PANELS = [
  { id: 'visits', title: 'Visits', series: [{ name: 'Web', values: [120, 180, 150] }, { name: 'App', values: [80, 95, 110] }], legend: 'right', gridLines: 4 },
  { id: 'signups', title: 'Sign-ups', series: [{ name: 'Trials', values: [12, 18, 25] }, { name: 'Paid', values: [3, 4, 6] }], legend: 'bottom', gridLines: 2 },
  { id: 'latency', title: 'Latency (ms)', series: [{ name: 'p95', values: [210, 190, 230] }], legend: 'none' },
];
