import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, apiError } from "@/lib/api";
import { today } from "@/lib/format";
import { Card, Btn, Input, Select, Modal, PageHeader, Empty } from "@/components/common";
import { Users, Plus, CheckCheck, Pencil, CalendarCheck, Wallet, Trash2 } from "lucide-react";
import SalariesManagement from "@/pages/SalariesManagement";
import { useAuth } from "@/context/AuthContext";

const DEPTS = [
  "CHEMICAL",
  "COVER STITCHING",
  "FABRIC CUTTING",
  "TAILORING (TAPE EDGE)",
  "MATTRESS PACKING (PLASTING)",
  "MATTRESS COVERING AND LOADING",
  "DRIVING",
  "SECURITY",
];

const weekPeriod = (offset = 0) => {
  const start = new Date(`${today()}T00:00:00Z`);
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday + offset * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 5);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

export default function Attendance() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [deletedEmployees, setDeletedEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  const [pieceRecords, setPieceRecords] = useState([]);
  const [pieceDraft, setPieceDraft] = useState({});
  const [pieceSaving, setPieceSaving] = useState({});
  const [pieceLoading, setPieceLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(today());
  const [empModal, setEmpModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rosterImporting, setRosterImporting] = useState(false);
  const [rosterResetting, setRosterResetting] = useState(false);
  const [attendanceSaving, setAttendanceSaving] = useState({});
  const [section, setSection] = useState("attendance");
  const [overtimeDraft, setOvertimeDraft] = useState({});
  const [workTimeDraft, setWorkTimeDraft] = useState({});
  const [shiftModeDraft, setShiftModeDraft] = useState({});
  const [workTimeSaving, setWorkTimeSaving] = useState({});
  const loadRequest = useRef(0);
  const attendanceSavingRef = useRef(new Set());
  const pieceSavingRef = useRef(new Set());

  const load = () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    Promise.all([api.get("/employees"), api.get("/attendance", { date }), api.get("/attendance/summary")])
      .then(([employeeData, attendanceData, summaryData]) => {
        if (requestId !== loadRequest.current) return;
        setEmployees(employeeData);
        setRecords(attendanceData);
        setSummary(summaryData);
      })
      .catch((e) => { if (requestId === loadRequest.current) toast.error(apiError(e)); })
      .finally(() => { if (requestId === loadRequest.current) setLoading(false); });
  };
  useEffect(() => { load(); }, [date, user?.company_id]);
  useEffect(() => {
    let activeRequest = true;
    setPieceLoading(true);
    api.get("/piece-production", { start_date: date, end_date: date })
      .then((data) => { if (activeRequest) setPieceRecords(data); })
      .catch((error) => { if (activeRequest) toast.error(apiError(error)); })
      .finally(() => { if (activeRequest) setPieceLoading(false); });
    return () => { activeRequest = false; };
  }, [date]);

  const active = employees.filter((e) => e.active !== false);
  const statusOf = (eid) => records.find((r) => r.employee_id === eid && r.date === date)?.status;
  const groups = useMemo(() => {
    const g = {};
    active.forEach((e) => { (g[e.department || "Other"] ||= []).push(e); });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [active]);
  const present = active.filter((e) => ["Present", "Half Day"].includes(statusOf(e.id))).length;
  const absent = active.filter((e) => statusOf(e.id) === "Absent").length;

  const applyAttendanceRecord = (employeeId, attendanceDate, previousStatus, nextStatus) => {
    const wasPresent = ["Present", "Half Day"].includes(previousStatus);
    const isPresent = ["Present", "Half Day"].includes(nextStatus);
    const weekStart = summary?.week_start;
    const monthStart = summary?.month_start;
    setSummary((current) => {
      if (!current) return current;
      const daily = { ...current.daily };
      if (attendanceDate === today()) {
        if (previousStatus) daily[previousStatus] = Math.max(0, (daily[previousStatus] || 0) - 1);
        if (nextStatus) daily[nextStatus] = (daily[nextStatus] || 0) + 1;
        Object.keys(daily).forEach((status) => { if (!daily[status]) delete daily[status]; });
      }
      const weekDelta = attendanceDate >= weekStart ? Number(isPresent) - Number(wasPresent) : 0;
      const monthDelta = attendanceDate >= monthStart ? Number(isPresent) - Number(wasPresent) : 0;
      return {
        ...current,
        daily,
        daily_total: attendanceDate === today()
          ? current.daily_total + Number(!!nextStatus) - Number(!!previousStatus)
          : current.daily_total,
        week_total: current.week_total + weekDelta,
        month_total: current.month_total + monthDelta,
        per_employee: current.per_employee.map((item) => item.employee_id !== employeeId ? item : {
          ...item,
          week: item.week + weekDelta,
          month: item.month + monthDelta,
        }),
      };
    });
  };
  const saveAttendance = async (employee, status, times) => {
    if (attendanceSavingRef.current.has(employee.id)) return false;
    attendanceSavingRef.current.add(employee.id);
    const previous = records.find((item) => item.employee_id === employee.id && item.date === date);
    const next = {
      ...previous,
      employee_id: employee.id,
      employee_name: employee.name,
      department: employee.department || "",
      date,
      status,
      overtime_hours: status === "Absent" ? 0 : previous?.overtime_hours || 0,
      start_time: status === "Absent" ? null : times.start_time,
      end_time: status === "Absent" ? null : times.end_time,
    };
    setAttendanceSaving((current) => ({ ...current, [employee.id]: true }));
    setRecords((current) => previous
      ? current.map((item) => item.id === previous.id ? next : item)
      : [...current, next]);
    applyAttendanceRecord(employee.id, date, previous?.status, status);
    try {
      const saved = await api.post("/attendance", next);
      setRecords((current) => current.map((item) =>
        item.employee_id === employee.id && item.date === date ? saved : item,
      ));
      setWorkTimeDraft((current) => { const updated = { ...current }; delete updated[employee.id]; return updated; });
      if (status === "Absent") {
        setShiftModeDraft((current) => { const updated = { ...current }; delete updated[employee.id]; return updated; });
      }
      return true;
    } catch (error) {
      setRecords((current) => {
        const withoutCurrent = current.filter((item) => item.employee_id !== employee.id || item.date !== date);
        return previous ? [...withoutCurrent, previous] : withoutCurrent;
      });
      applyAttendanceRecord(employee.id, date, status, previous?.status);
      toast.error(apiError(error));
      return false;
    } finally {
      attendanceSavingRef.current.delete(employee.id);
      setAttendanceSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const mark = async (emp, status) => {
    const record = records.find((item) => item.employee_id === emp.id && item.date === date);
    const saturday = new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
    const times = status === "Absent"
      ? { start_time: null, end_time: null }
      : {
        start_time: record?.start_time || "08:00",
        end_time: record?.end_time || (saturday ? "13:00" : "17:00"),
      };
    await saveAttendance(emp, status, times);
  };
  const saveWorkTime = async (employee, selectedTimes) => {
    const record = records.find((item) => item.employee_id === employee.id && item.date === date);
    if (!record || !["Present", "Half Day"].includes(record.status)) return;
    const draft = workTimeDraft[employee.id] || {};
    const startTime = selectedTimes?.start_time ?? draft.start_time ?? record.start_time ?? "";
    const endTime = selectedTimes?.end_time ?? draft.end_time ?? record.end_time ?? "";
    if (Boolean(startTime) !== Boolean(endTime)) return toast.error("Enter both the start and end times");
    setWorkTimeSaving((current) => ({ ...current, [employee.id]: true }));
    try {
      const saved = await saveAttendance(employee, record.status, {
        start_time: startTime || null,
        end_time: endTime || null,
      });
      if (saved && startTime && endTime) toast.success(`Work times saved for ${employee.name}`);
    } finally {
      setWorkTimeSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const savePieceCount = async (employee) => {
    const previous = pieceRecords.find((item) => item.employee_id === employee.id && item.date === date);
    if (pieceLoading || pieceSavingRef.current.has(employee.id)) return;
    const pieces = Number(pieceDraft[employee.id] ?? previous?.pieces ?? 0);
    if (!Number.isInteger(pieces) || pieces < 0) return toast.error("Pieces must be a whole number of zero or more");
    pieceSavingRef.current.add(employee.id);
    const optimistic = {
      ...previous,
      employee_id: employee.id,
      employee_name: employee.name,
      date,
      pieces,
    };
    setPieceSaving((current) => ({ ...current, [employee.id]: true }));
    setPieceRecords((current) => previous
      ? current.map((item) => item.employee_id === employee.id && item.date === date ? optimistic : item)
      : [...current, optimistic]);
    try {
      const saved = await api.post("/piece-production", optimistic);
      setPieceRecords((current) => current.map((item) =>
        item.employee_id === employee.id && item.date === date ? saved : item,
      ));
      setPieceDraft((current) => { const next = { ...current }; delete next[employee.id]; return next; });
      toast.success(`Piece count saved for ${employee.name}`);
    } catch (error) {
      setPieceRecords((current) => {
        const remaining = current.filter((item) => item.employee_id !== employee.id || item.date !== date);
        return previous ? [...remaining, previous] : remaining;
      });
      toast.error(apiError(error));
    } finally {
      pieceSavingRef.current.delete(employee.id);
      setPieceSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const deletePieceCount = async (employee) => {
    const previous = pieceRecords.find((item) => item.employee_id === employee.id && item.date === date);
    if (!previous || pieceLoading || pieceSavingRef.current.has(employee.id)) return;
    if (!window.confirm(`Delete the ${previous.pieces}-piece production record for ${employee.name} on ${date}? The entire week’s pay will be recalculated.`)) return;
    pieceSavingRef.current.add(employee.id);
    setPieceSaving((current) => ({ ...current, [employee.id]: true }));
    setPieceRecords((current) => current.filter((item) => item.id !== previous.id));
    try {
      await api.del(`/piece-production/${previous.id}`);
      toast.success(`Piece count deleted for ${employee.name}`);
    } catch (error) {
      setPieceRecords((current) => [...current, previous]);
      toast.error(apiError(error));
    } finally {
      pieceSavingRef.current.delete(employee.id);
      setPieceSaving((current) => ({ ...current, [employee.id]: false }));
    }
  };
  const saveOvertime = async (employee) => {
    const record = records.find((item) => item.employee_id === employee.id && item.date === date);
    if (!record || !["Present", "Half Day"].includes(record.status)) return;
    const overtime = Number(overtimeDraft[employee.id] ?? record.overtime_hours ?? 0);
    if (!Number.isFinite(overtime) || overtime < 0) return toast.error("Overtime hours must be zero or more");
    try {
      const updated = await api.post("/attendance", { employee_id: employee.id, date, status: record.status, overtime_hours: overtime });
      setRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
      setOvertimeDraft((current) => { const next = { ...current }; delete next[employee.id]; return next; });
    } catch (e) { toast.error(apiError(e)); }
  };
  const markAll = async () => {
    if (busy) return; setBusy(true);
    try { await api.post("/attendance/bulk", { date, status: "Present", employee_ids: active.map((e) => e.id) }); toast.success("All marked present"); load(); }
    catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };
  const importPayrollRoster = async () => {
    if (!window.confirm("Update the employee list to match the supplied 31-person roster? This updates salaries and departments, merges duplicate profiles, and archives employees not on the list. Attendance and salary history will be kept.")) return;
    setRosterImporting(true);
    try {
      const result = await api.post("/employees/import-roster", {});
      toast.success(`Employee list updated: ${result.added} added, ${result.updated} updated, ${result.duplicates_archived} duplicates merged, ${result.unlisted_archived} unlisted archived`);
      load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setRosterImporting(false);
    }
  };
  const resetPayrollRosterAndAttendance = async () => {
    if (!window.confirm("This will archive employees not shown in the supplied roster, merge duplicate profiles with the same name, permanently delete all attendance history, and mark the roster present for the full current work week. This cannot be undone. Continue?")) return;
    setRosterResetting(true);
    try {
      const result = await api.post("/employees/reconcile-payroll-roster", {});
      toast.success(
        `Roster updated: ${result.added} added, ${result.duplicates_archived} duplicates merged, ${result.unlisted_archived} unlisted archived. ${result.attendance_deleted} attendance records deleted; ${result.attendance_created} present records created for ${result.week_start}–${result.week_end}.`,
      );
      load();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setRosterResetting(false);
    }
  };
  const saveEmp = async () => {
    if (!empModal.name.trim()) return toast.error("Name required");
    if (!DEPTS.includes(empModal.department)) return toast.error("Select a standard department");
    try { empModal.id ? await api.put(`/employees/${empModal.id}`, empModal) : await api.post("/employees", empModal); setEmpModal(null); load(); toast.success("Employee saved"); }
    catch (e) { toast.error(apiError(e)); }
  };
  const deleteEmployee = async (employee) => {
    if (!window.confirm(`Permanently delete ${employee.name} from this profile? The employee will appear in Deleted employees; attendance and salary history will be retained.`)) return;
    try {
      await api.del(`/employees/${employee.id}`);
      setEmployees((current) => current.filter((item) => item.id !== employee.id));
      toast.success("Employee permanently deleted; history retained");
    } catch (error) {
      toast.error(apiError(error));
      return;
    }
    try { setDeletedEmployees(await api.get("/employees/deleted")); }
    catch (error) { toast.error(`Employee deleted, but deleted-employee archive could not be refreshed: ${apiError(error)}`); }
  };
  const Stat = ({ l, v, cls, k }) => <Card className="p-4" data-testid={`att-${k}`}><p className="text-xs text-slate-400 uppercase font-semibold">{l}</p><p className={`text-2xl font-bold font-mono mt-1 ${cls}`}>{v}</p></Card>;

  return (
    <div className="space-y-6">
      <PageHeader title="Attendance" subtitle="Tap Present or Absent for each employee">
        {section === "attendance" && <>
          <Btn variant="outline" onClick={() => setEmpModal({ name: "", department: "", active: true })} data-testid="add-employee-btn"><Plus size={16} /> Employee</Btn>
          {(user?.is_admin || user?.role === "admin" || user?.is_owner) && <>
            <Btn variant="outline" disabled={rosterImporting} onClick={importPayrollRoster} data-testid="import-payroll-roster-btn">{rosterImporting ? "Updating list…" : "Update employee list"}</Btn>
          </>}
          <Btn disabled={loading || busy || !active.length} onClick={markAll} data-testid="mark-all-present-btn"><CheckCheck size={16} /> Mark All Present</Btn>
        </>}
      </PageHeader>
      <div className="flex gap-2 border-b border-border">
        <button onClick={() => setSection("attendance")} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${section === "attendance" ? "border-primary text-primary" : "border-transparent text-slate-500"}`} data-testid="attendance-section-tab"><CalendarCheck size={16} /> Attendance</button>
        {(user?.is_admin || user?.role === "admin" || user?.is_owner) && <button onClick={() => setSection("salaries")} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${section === "salaries" ? "border-primary text-primary" : "border-transparent text-slate-500"}`} data-testid="salary-section-tab"><Wallet size={16} /> Salaries</button>}
        {user?.is_owner && <button onClick={async () => {
          setSection("deleted");
          try { setDeletedEmployees(await api.get("/employees/deleted")); }
          catch (error) { toast.error(apiError(error)); }
        }} className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${section === "deleted" ? "border-primary text-primary" : "border-transparent text-slate-500"}`} data-testid="deleted-employees-tab"><Trash2 size={15} /> Deleted employees ({deletedEmployees.length})</button>}
      </div>
      {section === "deleted" && user?.is_owner ? (
        <Card className="overflow-hidden">
          {deletedEmployees.length === 0 ? <Empty icon={Users} title="No deleted employees" /> : <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-50 text-left text-xs text-slate-400"><th className="px-4 py-3">Name</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">Deleted</th></tr></thead>
              <tbody>{deletedEmployees.map((employee) => <tr key={employee.id} className="border-t border-border/60" data-testid={`deleted-employee-row-${employee.id}`}>
                <td className="px-4 py-3 font-semibold text-slate-800">{employee.name}</td><td className="px-4 py-3 text-slate-500">{employee.department || "—"}</td><td className="px-4 py-3 text-slate-500">{employee.deleted_at ? new Date(employee.deleted_at).toLocaleString() : "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </Card>
      ) : section === "salaries" && (user?.is_admin || user?.role === "admin" || user?.is_owner) ? (
        <SalariesManagement />
      ) : (
      <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-48"><Input label="Date" type="date" value={date} onChange={(e) => { setDate(e.target.value); setOvertimeDraft({}); setWorkTimeDraft({}); setShiftModeDraft({}); }} data-testid="attendance-date-input" /></div>
        <p className="pb-2 text-sm text-slate-500">Select a shift for hourly employees. Ayanda Tailor and Asive Tailor are paid by weekly piece count.</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat l="Present (day)" v={loading ? "..." : present} cls="text-emerald-600" k="day-present" />
        <Stat l="Absent (day)" v={loading ? "..." : absent} cls="text-red-600" k="day-absent" />
        <Stat l="Not marked" v={loading ? "..." : active.length - present - absent} cls="text-slate-500" k="day-unmarked" />
        <Stat l="Present days (week)" v={loading ? "..." : summary?.week_total ?? 0} cls="text-slate-800" k="week" />
        <Stat l="Present days (month)" v={loading ? "..." : summary?.month_total ?? 0} cls="text-slate-800" k="month" />
      </div>
      {loading ? <Card><p className="p-6 text-sm text-slate-400" role="status">Loading employees...</p></Card> : active.length === 0 ? <Card><Empty icon={Users} title="No employees yet" hint="Add employees with the + Employee button." /></Card> : groups.map(([dept, list]) => (
        <Card key={dept} className="p-4">
          <p className="text-xs font-bold uppercase text-slate-500 mb-3">{dept} <span className="text-slate-300">· {list.length}</span></p>
          <div className="space-y-2">{list.map((e) => {
            const s = statusOf(e.id);
            const per = summary?.per_employee?.find((p) => p.employee_id === e.id);
            const record = records.find((item) => item.employee_id === e.id && item.date === date);
            const timeDraft = workTimeDraft[e.id] || {};
            const startTime = timeDraft.start_time ?? record?.start_time ?? "";
            const endTime = timeDraft.end_time ?? record?.end_time ?? "";
            const isSaturday = new Date(`${date}T00:00:00Z`).getUTCDay() === 6;
            const shiftMode = shiftModeDraft[e.id] || (
              startTime === "08:00" && endTime === "17:00" ? "08:00-17:00"
                : startTime === "08:00" && endTime === "13:00" ? "08:00-13:00"
                  : startTime && endTime ? "custom"
                    : isSaturday ? "08:00-13:00" : "08:00-17:00"
            );
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-2" data-testid={`att-row-${e.id}`}>
                <div className="flex-1 min-w-[140px]"><p className="font-semibold text-slate-800">{e.name}</p><p className="text-[11px] text-slate-400">Week {per?.week ?? 0} · Month {per?.month ?? 0} days</p></div>
                {e.pay_type === "piece" && <>
                  <div className="w-32"><Input label="Pieces today" type="number" min="0" step="1"
                    value={pieceDraft[e.id] ?? pieceRecords.find((item) => item.employee_id === e.id && item.date === date)?.pieces ?? 0}
                    onChange={(event) => setPieceDraft((current) => ({ ...current, [e.id]: event.target.value }))}
                    disabled={pieceLoading || !!pieceSaving[e.id]} data-testid={`piece-count-${e.id}`} /></div>
                  <Btn variant="outline" disabled={pieceLoading || !!pieceSaving[e.id]}
                    onClick={() => savePieceCount(e)} data-testid={`save-piece-count-${e.id}`}>
                    {pieceSaving[e.id] ? "Saving…" : "Save pieces"}
                  </Btn>
                  {pieceRecords.some((item) => item.employee_id === e.id && item.date === date) && <Btn
                    variant="danger" disabled={pieceLoading || !!pieceSaving[e.id]}
                    onClick={() => deletePieceCount(e)} data-testid={`delete-piece-count-${e.id}`}>
                    Delete
                  </Btn>}
                </>}
                <button disabled={!!attendanceSaving[e.id]} onClick={() => mark(e, "Present")} data-testid={`present-btn-${e.id}`} className={`h-12 w-32 rounded-xl text-sm font-bold border-2 transition-colors disabled:opacity-60 ${s === "Present" ? "bg-emerald-600 border-emerald-600 text-white" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}>{attendanceSaving[e.id] && s === "Present" ? "Saving…" : "Present"}</button>
                <button disabled={!!attendanceSaving[e.id]} onClick={() => mark(e, "Absent")} data-testid={`absent-btn-${e.id}`} className={`h-12 w-32 rounded-xl text-sm font-bold border-2 transition-colors disabled:opacity-60 ${s === "Absent" ? "bg-red-600 border-red-600 text-white" : "border-red-200 text-red-700 hover:bg-red-50"}`}>{attendanceSaving[e.id] && s === "Absent" ? "Saving…" : "Absent"}</button>
                {e.pay_type !== "piece" && ["Present", "Half Day"].includes(s) && <>
                  <div className="w-40"><Select label="Work shift" value={shiftMode} disabled={!!attendanceSaving[e.id] || !!workTimeSaving[e.id]}
                    onChange={(event) => {
                      const mode = event.target.value;
                      setShiftModeDraft((current) => ({ ...current, [e.id]: mode }));
                      if (mode === "custom") {
                        if (shiftMode !== "custom") setWorkTimeDraft((current) => ({ ...current, [e.id]: { start_time: "", end_time: "" } }));
                        return;
                      }
                      const [start_time, end_time] = mode.split("-");
                      setWorkTimeDraft((current) => ({ ...current, [e.id]: { start_time, end_time } }));
                      saveWorkTime(e, { start_time, end_time });
                    }} data-testid={`attendance-shift-${e.id}`}>
                    <option value="08:00-17:00">8:00–17:00</option>
                    <option value="08:00-13:00">8:00–13:00</option>
                    <option value="custom">Custom</option>
                  </Select></div>
                  {shiftMode === "custom" && <>
                  <div className="w-32"><Input label="From" type="time" value={startTime}
                    onChange={(event) => setWorkTimeDraft((current) => ({ ...current, [e.id]: { ...current[e.id], start_time: event.target.value } }))}
                    data-testid={`attendance-start-time-${e.id}`} /></div>
                  <div className="w-32"><Input label="To" type="time" value={endTime}
                    onChange={(event) => setWorkTimeDraft((current) => ({ ...current, [e.id]: { ...current[e.id], end_time: event.target.value } }))}
                    data-testid={`attendance-end-time-${e.id}`} /></div>
                  <Btn variant="outline" disabled={!!workTimeSaving[e.id]} onClick={() => saveWorkTime(e)} data-testid={`attendance-save-times-${e.id}`}>
                    {workTimeSaving[e.id] ? "Saving..." : "Save hours"}
                  </Btn>
                  </>}
                  {!((record?.start_time && record?.end_time) || shiftMode !== "custom") && <div className="w-32"><Input label="Overtime hours" type="number" min="0" step="0.25" value={overtimeDraft[e.id] ?? record?.overtime_hours ?? 0}
                  onChange={(event) => setOvertimeDraft((current) => ({ ...current, [e.id]: event.target.value }))} onBlur={() => saveOvertime(e)} data-testid={`attendance-overtime-${e.id}`} /></div>}
                </>}
                <button onClick={() => setEmpModal({ ...e })} className="text-slate-300 hover:text-primary" data-testid={`edit-employee-${e.id}`}><Pencil size={15} /></button>
                {user?.is_owner && <button onClick={() => deleteEmployee(e)} className="text-slate-300 hover:text-red-600" aria-label={`Permanently delete ${e.name}`} title="Permanently delete employee" data-testid={`delete-employee-${e.id}`}><Trash2 size={15} /></button>}
              </div>);
          })}</div>
        </Card>))}
      <Modal open={!!empModal} onClose={() => setEmpModal(null)} title={empModal?.id ? "Edit Employee" : "Add Employee"}>
        {empModal && <div className="space-y-4">
          <Input label="Name *" value={empModal.name} onChange={(e) => setEmpModal({ ...empModal, name: e.target.value })} data-testid="employee-name-input" />
          <Select label="Department" value={empModal.department || ""} onChange={(e) => setEmpModal({ ...empModal, department: e.target.value })} data-testid="employee-dept-select">
            <option value="">Select a department</option>
            {empModal.department && !DEPTS.includes(empModal.department) && <option value={empModal.department}>{empModal.department} (legacy)</option>}
            {DEPTS.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={empModal.active !== false} onChange={(e) => setEmpModal({ ...empModal, active: e.target.checked })} /> Active</label>
          <div className="flex justify-end gap-2"><Btn variant="outline" onClick={() => setEmpModal(null)}>Cancel</Btn><Btn onClick={saveEmp} data-testid="save-employee-btn">Save</Btn></div>
        </div>}
      </Modal>
      </>
      )}
    </div>
  );
}
