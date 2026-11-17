package model

type PerformanceProcess struct {
	PID           int      `json:"pid"`
	ParentPID     int      `json:"parentPid"`
	Name          string   `json:"name"`
	Kind          string   `json:"kind"`
	Role          string   `json:"role"`
	CPUPercent    *float64 `json:"cpuPercent"`
	MemoryBytes   *uint64  `json:"memoryBytes"`
	UptimeSeconds *float64 `json:"uptimeSeconds"`
}

type PerformanceSample struct {
	SampledAt         int64                `json:"sampledAt"`
	IntervalMs        int64                `json:"intervalMs"`
	MainPID           int                  `json:"mainPid"`
	MainUptimeSeconds float64              `json:"mainUptimeSeconds"`
	TotalCPUPercent   *float64             `json:"totalCpuPercent"`
	TotalMemoryBytes  *uint64              `json:"totalMemoryBytes"`
	Processes         []PerformanceProcess `json:"processes"`
	SensorLimited     bool                 `json:"sensorLimited"`
}
