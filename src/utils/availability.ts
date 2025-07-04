import { CalendarEvent } from '../types/calendar.js';
import { parse } from 'date-fns';

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface AvailabilityOptions {
  startTime: string; // "09:00"
  endTime: string;   // "18:00"
  duration: number;  // minutes
  excludeWeekends?: boolean;
}

export function findAvailableSlots(
  events: CalendarEvent[],
  date: Date,
  options: AvailabilityOptions
): TimeSlot[] {
  const { startTime, endTime, duration, excludeWeekends = true } = options;

  // 週末をスキップ
  if (excludeWeekends && (date.getDay() === 0 || date.getDay() === 6)) {
    return [];
  }

  // 営業時間の開始・終了時刻を作成
  const workStart = parse(startTime, 'HH:mm', date);
  const workEnd = parse(endTime, 'HH:mm', date);

  // その日のイベントをフィルタリング
  const dayEvents = events
    .filter(event => {
      const startDateTime = event.start.timeZone === 'Asia/Tokyo' 
        ? event.start.dateTime + '+09:00'
        : event.start.dateTime + 'Z';
      const eventStart = new Date(startDateTime);
      return eventStart.toDateString() === date.toDateString();
    })
    .sort((a, b) => {
      const aStartDateTime = a.start.timeZone === 'Asia/Tokyo' 
        ? a.start.dateTime + '+09:00'
        : a.start.dateTime + 'Z';
      const bStartDateTime = b.start.timeZone === 'Asia/Tokyo'
        ? b.start.dateTime + '+09:00'
        : b.start.dateTime + 'Z';
      return new Date(aStartDateTime).getTime() - new Date(bStartDateTime).getTime();
    });

  const availableSlots: TimeSlot[] = [];
  let currentTime = workStart;

  dayEvents.forEach(event => {
    const startDateTime = event.start.timeZone === 'Asia/Tokyo' 
      ? event.start.dateTime + '+09:00'
      : event.start.dateTime + 'Z';
    const endDateTime = event.end.timeZone === 'Asia/Tokyo'
      ? event.end.dateTime + '+09:00'
      : event.end.dateTime + 'Z';
    const eventStart = new Date(startDateTime);
    const eventEnd = new Date(endDateTime);

    // イベント開始前に空き時間があるか確認
    if (currentTime < eventStart) {
      const gap = eventStart.getTime() - currentTime.getTime();
      if (gap >= duration * 60 * 1000) {
        availableSlots.push({
          start: currentTime,
          end: eventStart
        });
      }
    }

    // 次の検索開始時刻を更新
    if (eventEnd > currentTime) {
      currentTime = eventEnd;
    }
  });

  // 最後のイベント後から営業時間終了まで
  if (currentTime < workEnd) {
    const gap = workEnd.getTime() - currentTime.getTime();
    if (gap >= duration * 60 * 1000) {
      availableSlots.push({
        start: currentTime,
        end: workEnd
      });
    }
  }

  return availableSlots;
}

export function findBestSlot(
  availableSlots: TimeSlot[],
  preferredTime?: string // "morning", "afternoon", "evening"
): TimeSlot | null {
  if (availableSlots.length === 0) return null;

  if (!preferredTime) return availableSlots[0];

  // 時間帯の優先順位に基づいて選択
  const timePreferences = {
    morning: (slot: TimeSlot) => slot.start.getHours() < 12,
    afternoon: (slot: TimeSlot) => slot.start.getHours() >= 12 && slot.start.getHours() < 17,
    evening: (slot: TimeSlot) => slot.start.getHours() >= 17
  };

  const preference = timePreferences[preferredTime as keyof typeof timePreferences];
  const preferredSlot = availableSlots.find(preference);

  return preferredSlot || availableSlots[0];
}