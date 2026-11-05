# Project Specification: AI Automatic Timetable Generator
> Target Score: 95+/100 (National Competition Gold Level)
> Role: Full-Stack & AI Optimization Engine

---

## 1. System Overview & Architecture
* **Goal**: Automatic class scheduling system resolving complex constraints using AI.
* **Architecture**: Modern Web App (Frontend + API Service) deployed on Cloud (Docker-ready).
* **Target Users**: School Administrators, Teachers, Students, Competition Judges.

---

## 2. Core Entities & Data Schema (Inputs)

### 2.1 Teacher Model
* `id`: String (Unique)
* `name`: String
* `maxHoursPerDay`: Number (Default: 6)
* `maxHoursPerWeek`: Number
* `unavailableSlots`: Array<`TimeSlot`> (e.g., `["MON_P1", "FRI_P5"]`)

### 2.2 Course / Subject Model
* `id`: String (Unique)
* `code`: String
* `name`: String
* `periodsPerWeek`: Number
* `requiredRoomType`: Enum (`THEORY`, `LAB`, `SPECIFIC`)
* `assignedTeacherId`: String

### 2.3 Room Model
* `id`: String (Unique)
* `name`: String
* `type`: Enum (`THEORY`, `LAB`, `SPECIFIC`)
* `capacity`: Number

### 2.4 Class Group / Student Model
* `id`: String (Unique)
* `groupName`: String (e.g., "AI-ปวส.1")
* `studentCount`: Number
* `department`: String
* `parallelGroupIds`: Array<String> (กลุ่มเรียนคู่ขนานที่ต้องไม่ซ้อนกัน)

### 2.5 Time Slot Model
* `day`: Enum (`MON`, `TUE`, `WED`, `THU`, `FRI`)
* `period`: Number (1 to 8)
* `startTime`: String ("08:30")
* `endTime`: String ("09:30")

---

## 3. Data Validation & Auto-Fix Specs (Score Target: 10/10)

### Validation Rules (Check before engine execution):
1. **Duplicate ID Check**: Highlight duplicated IDs in red.
2. **Missing Required Fields**: Highlight empty cells.
3. **Capacity Warning**: `studentCount > room.capacity`.
4. **Time Slot Format**: Must follow `HH:MM-HH:MM` or standard period IDs.
5. **Teacher Availability**: Total requested periods <= Teacher max capacity.

### UX & Auto-Fix Options:
* **Preview Screen**: Show total rows, valid count, error count.
* **Interactive Data Grid**: Highlight error cells with Zod schema validation badges.
* **Actions**:
  * Option A: `Re-upload File` (Clear state & upload fixed CSV/Excel).
  * Option B: `Auto-Fix / Clean Data` (Drop invalid rows or apply default values / AI format correction).

---

## 4. Scheduling Engine & Constraint Rules (Score Target: 35/35)

### Hard Constraints (ZERO Conflict Required - 100% Pass):
* `H1`: Teacher cannot teach >1 room at the same time.
* `H2`: Room cannot host >1 class at the same time.
* `H3`: Student Group cannot attend >1 class at the same time.
* `H4`: Room type must match course requirement (`LAB` course -> `LAB` room).
* `H5`: No scheduling during teacher's `unavailableSlots`.

### Soft Constraints (Optimization Objectives):
* `S1`: Even distribution of teaching hours across days.
* `S2`: Minimize idle time slots (คาบว่าง) for student groups.
* `S3`: Prefer consecutive periods for lab/practical courses.
* `S4`: Respect room capacity limits optimally.

---

## 5. AI Approach & Agentic Design (Score Target: 20/20)

### Engine Architecture (Agentic Plan-Act-Check Flow):
* **Planner Agent**: Analyzes data size, classifies constraints, and initializes seed population / CSP bounds.
* **Solver Agent**: Executes Genetic Algorithm (GA) or Constraint Satisfaction Problem (CSP) / Local Search.
* **Evaluator Agent**: Calculates fitness score, verifies hard constraint violations (`conflictCount = 0`), and logs execution metrics.

### AI Engine Mandatory Features:
* **Deterministic / Seed Support**: Must accept a `seed` parameter to ensure 100% reproducible results for judges.
* **Benchmark Comparison**: Output metric proof showing `AI Engine Conflict Reduction` vs `Naive Greed Approach` (e.g., Time taken, Fitness score).

---

## 6. Output & Analytics Specs (Score Target: 8/8)

### Views:
* **By Teacher**: Weekly schedule matrix per teacher.
* **By Room**: Utilization timetable per room.
* **By Student Group**: Class schedule view.

### Analytics Dashboard (Key Metrics):
* `Room Utilization Rate (%)`
* `Total Idle Slots`
* `Teacher Workload Distribution Graph`
* `Hard Conflict Count` (Must show `0`)

### Exports:
* Export printable schedule views to **PDF**.
* Export raw schedule tables to **Excel (.xlsx) / CSV**.

---

## 7. Quality & Deployment Specs (Score Target: 12/12)

### Performance & UX (10 pts):
* **Progress Tracking**: Real-time progress bar / loading state during AI processing with `Cancel` button.
* **Error Resilience**: Graceful error handling (No app crashes, clear fallback messages).

### Ops / Cloud Readiness (2 pts):
* App must be deployed on Cloud (e.g., Vercel / Railway / Docker-ready).
* Provide `Quick Guide` & test credentials (`username/password`) for competition judges.