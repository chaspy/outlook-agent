import { MgcService } from '../../services/mgc.js';
import { selectUser } from '../../utils/interactive.js';
import { format, addDays, addMinutes } from 'date-fns';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { CalendarEvent } from '../../types/calendar.js';
import { isWorkday } from '../../utils/holidays.js';
import { createJSTDate, formatJST, isSameDayJST } from '../../utils/timezone.js';

export async function createEvent(options: { 
  findSlot?: boolean;
  interactive?: boolean;
  nonInteractive?: boolean;
  subject?: string;
  attendees?: string[];
  duration?: number;
  outputFormat?: 'json' | 'text';
} = {}): Promise<void> {
  const mgc = new MgcService();

  try {
    let eventData: any = {};

    // 非対話型モード
    if (options.nonInteractive && options.subject && options.attendees && options.attendees.length > 0) {
      eventData.subject = options.subject;
      eventData.attendees = options.attendees.map(email => ({ emailAddress: { address: email } }));
      const duration = options.duration || 30;

      // 空き時間を探す
      const now = new Date();
      
      // Free/Busy APIのために現在時刻を30分単位に丸める（切り捨て）
      const alignedNow = new Date(now);
      alignedNow.setMinutes(Math.floor(alignedNow.getMinutes() / 30) * 30, 0, 0);
      
      const searchDays = 14;
      const endSearchDate = addDays(alignedNow, searchDays);
      
      const startDateStr = format(now, 'yyyy-MM-dd');
      const endDateStr = format(endSearchDate, 'yyyy-MM-dd');
      const attendeeEmails = options.attendees;
      
      // カレンダーとFree/Busy情報を取得
      const [myEvents, freeBusyResult] = await Promise.all([
        mgc.getMyCalendarEvents(
          `${startDateStr}T00:00:00+09:00`,
          `${endDateStr}T23:59:59+09:00`
        ).catch(() => [] as CalendarEvent[]),
        mgc.getUserFreeBusy(
          attendeeEmails,
          alignedNow.toISOString(),
          endSearchDate.toISOString()
        )
      ]);

      // 空き時間を探す（既存のロジックを使用）
      const candidates: Array<{ date: Date; start: Date; end: Date }> = [];
      
      for (let i = 0; i < searchDays; i++) {
        const date = addDays(now, i);
        const dateStr = format(date, 'yyyy-MM-dd');
        
        if (!isWorkday(date)) continue;
        
        let searchStartTime = createJSTDate(dateStr, 9, 0);
        let searchEndTime = createJSTDate(dateStr, 19, 0);
        
        if (process.env.DEBUG && dateStr === '2025-07-07') {
          console.log(`\nDEBUG 7/7: Search times:`);
          console.log(`  Start: ${searchStartTime.toISOString()} (${formatJST(searchStartTime, 'HH:mm')} JST)`);
          console.log(`  End: ${searchEndTime.toISOString()} (${formatJST(searchEndTime, 'HH:mm')} JST)`);
        }
        
        if (i === 0) {
          const minStartTime = addMinutes(now, 30);
          if (minStartTime > searchStartTime) {
            searchStartTime = minStartTime;
          }
        }

        let currentTime = new Date(searchStartTime);
        while (currentTime < searchEndTime && addMinutes(currentTime, duration) <= searchEndTime) {
          const slotEnd = addMinutes(currentTime, duration);
          let allAvailable = true;
          
          if (process.env.DEBUG && (
            (dateStr === '2025-07-07' && (formatJST(currentTime, 'HH:mm') === '11:00' || formatJST(currentTime, 'HH:mm') === '18:00')) ||
            (dateStr === '2025-07-09' && (formatJST(currentTime, 'HH:mm') === '17:30' || formatJST(currentTime, 'HH:mm') === '18:00'))
          )) {
            console.log(`\nDEBUG ${dateStr} ${formatJST(currentTime, 'HH:mm')}: Checking slot ${formatJST(currentTime, 'HH:mm')}-${formatJST(slotEnd, 'HH:mm')} JST`);
            console.log(`  Total events to check: ${myEvents.length}`);
          }
          
          // 自分のカレンダーをチェック
          for (const event of myEvents) {
            // Declinedイベントはスキップ
            if (event.subject?.startsWith('Declined:')) {
              continue;
            }
            
            // デバッグ: 7/7 11:00と7/9 18:00のスロットで全イベントを表示
            if (process.env.DEBUG && ((dateStr === '2025-07-07' && formatJST(currentTime, 'HH:mm') === '11:00') || (dateStr === '2025-07-09' && formatJST(currentTime, 'HH:mm') === '18:00'))) {
              const tempStartDateTime = event.start.timeZone === 'Asia/Tokyo' 
                ? event.start.dateTime + '+09:00'
                : event.start.dateTime + 'Z';
              const tempEndDateTime = event.end.timeZone === 'Asia/Tokyo'
                ? event.end.dateTime + '+09:00'
                : event.end.dateTime + 'Z';
              const eventStartJST = formatJST(new Date(tempStartDateTime), 'yyyy-MM-dd HH:mm');
              const eventEndJST = formatJST(new Date(tempEndDateTime), 'HH:mm');
              console.log(`  Event: "${event.subject}" ${eventStartJST}-${eventEndJST} JST (showAs: ${event.showAs})`);
            }
            
            // タイムゾーン処理
            // timeZoneが指定されている場合はそのまま、ない場合はUTCとして解釈
            const startDateTime = event.start.timeZone === 'Asia/Tokyo' 
              ? event.start.dateTime + '+09:00'
              : event.start.dateTime + 'Z';
            const endDateTime = event.end.timeZone === 'Asia/Tokyo'
              ? event.end.dateTime + '+09:00'
              : event.end.dateTime + 'Z';
              
            const eventStart = new Date(startDateTime);
            const eventEnd = new Date(endDateTime);
            
            if (!isSameDayJST(eventStart, currentTime) &&
                !isSameDayJST(eventEnd, currentTime)) {
              continue;
            }
            
            if (event.isAllDay && isSameDayJST(eventStart, currentTime)) {
              if (event.showAs !== 'free') {
                allAvailable = false;
                break;
              }
            }
            
            if ((currentTime >= eventStart && currentTime < eventEnd) ||
                (slotEnd > eventStart && slotEnd <= eventEnd) ||
                (currentTime <= eventStart && slotEnd >= eventEnd)) {
              if (event.showAs !== 'free') {
                allAvailable = false;
                if (process.env.DEBUG && (
                  (dateStr === '2025-07-07' && (formatJST(currentTime, 'HH:mm') === '11:00' || formatJST(currentTime, 'HH:mm') === '18:00')) ||
                  (dateStr === '2025-07-09' && (formatJST(currentTime, 'HH:mm') === '17:30' || formatJST(currentTime, 'HH:mm') === '18:00'))
                )) {
                  console.log(`  Blocked by: "${event.subject}" (${formatJST(eventStart, 'HH:mm')}-${formatJST(eventEnd, 'HH:mm')} JST, showAs: ${event.showAs})`);
                }
                break;
              }
            }
          }
          
          // 参加者のFree/Busyをチェック
          if (allAvailable) {
            const schedules = freeBusyResult.value || [];
            
            for (let scheduleIndex = 0; scheduleIndex < schedules.length; scheduleIndex++) {
              const schedule = schedules[scheduleIndex];
              
              if (schedule.availabilityView) {
                const slotStartTime = currentTime.getTime();
                const requestStartTime = alignedNow.getTime();
                const minutesFromStart = (slotStartTime - requestStartTime) / (1000 * 60);
                const slotIndex = Math.floor(minutesFromStart / 30);
                
                if (process.env.DEBUG && (
                  (dateStr === '2025-07-07' && (formatJST(currentTime, 'HH:mm') === '11:00' || formatJST(currentTime, 'HH:mm') === '18:00')) ||
                  (dateStr === '2025-07-09' && formatJST(currentTime, 'HH:mm') === '17:30')
                )) {
                  console.log(`  DEBUG: Slot index calculation:`);
                  console.log(`    currentTime: ${currentTime.toISOString()}`);
                  console.log(`    requestStartTime: ${new Date(requestStartTime).toISOString()}`);
                  console.log(`    minutesFromStart: ${minutesFromStart}`);
                  console.log(`    slotIndex: ${slotIndex}`);
                }
                
                if (slotIndex >= 0 && slotIndex < schedule.availabilityView.length) {
                  const availability = schedule.availabilityView.charAt(slotIndex);
                  
                  // Special debug for 7/7 11:00
                  if (process.env.DEBUG && dateStr === '2025-07-07' && formatJST(currentTime, 'HH:mm') === '11:00') {
                    console.log(`  DEBUG 7/7 11:00: Availability view index ${slotIndex} = '${availability}' for ${attendeeEmails[scheduleIndex]}`);
                    // Show context around this slot
                    const start = Math.max(0, slotIndex - 2);
                    const end = Math.min(schedule.availabilityView.length, slotIndex + 3);
                    console.log(`    Context: "${schedule.availabilityView.substring(start, end)}" (positions ${start}-${end})`);
                  }
                  
                  if (availability !== '0') {
                    allAvailable = false;
                    if (process.env.DEBUG && (
                  (dateStr === '2025-07-07' && (formatJST(currentTime, 'HH:mm') === '11:00' || formatJST(currentTime, 'HH:mm') === '18:00')) ||
                  (dateStr === '2025-07-09' && formatJST(currentTime, 'HH:mm') === '17:30')
                )) {
                      console.log(`  ✗ Attendee ${attendeeEmails[scheduleIndex]} is busy (availability: ${availability})`);
                    }
                    break;
                  }
                }
              }
            }
          }
          
          if (allAvailable) {
            if (process.env.DEBUG && dateStr === '2025-07-07' && (formatJST(currentTime, 'HH:mm') === '11:00' || formatJST(currentTime, 'HH:mm') === '18:00')) {
              console.log(`  ✓ Slot is available! Adding to candidates.`);
            }
            candidates.push({
              date: date,
              start: new Date(currentTime),
              end: new Date(slotEnd)
            });
          } else {
            if (process.env.DEBUG && dateStr === '2025-07-07' && (formatJST(currentTime, 'HH:mm') === '11:00' || formatJST(currentTime, 'HH:mm') === '18:00')) {
              console.log(`  ✗ Slot is NOT available.`);
            }
          }
          
          currentTime = addMinutes(currentTime, 30);
        }
      }

      // 結果を出力
      if (options.outputFormat === 'json') {
        const result = {
          success: candidates.length > 0,
          subject: options.subject,
          attendees: options.attendees,
          duration: duration,
          availableSlots: candidates.slice(0, 20).map(c => ({
            date: format(c.date, 'yyyy-MM-dd'),
            start: formatJST(c.start, 'HH:mm'),
            end: formatJST(c.end, 'HH:mm'),
            startISO: c.start.toISOString(),
            endISO: c.end.toISOString()
          }))
        };
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (candidates.length === 0) {
          console.log(chalk.yellow('No available time slots found'));
        } else {
          console.log(chalk.blue(`Found ${candidates.length} available time slots:`));
          candidates.slice(0, 20).forEach((c, i) => {
            console.log(`${i + 1}. ${format(c.date, 'EEE, MMM d')} ${formatJST(c.start, 'HH:mm')}-${formatJST(c.end, 'HH:mm')} JST`);
          });
        }
      }
      
      return;
    }

    if (options.interactive || options.findSlot) {
      // インタラクティブモード
      const { subject } = await inquirer.prompt([
        {
          type: 'input',
          name: 'subject',
          message: 'Event title:',
          validate: (input: string) => input.length > 0 || 'Title is required'
        }
      ]);
      eventData.subject = subject;

      // 参加者選択
      const attendees = [];
      let addMore = true;
      while (addMore) {
        console.log(chalk.gray('\nSelect attendee (or press ESC to finish):'));
        const attendeeEmail = await selectUser();
        if (attendeeEmail) {
          attendees.push({ emailAddress: { address: attendeeEmail } });
        }
        
        if (attendees.length > 0) {
          const { continue: shouldContinue } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'continue',
              message: 'Add another attendee?',
              default: false
            }
          ]);
          addMore = shouldContinue;
        } else {
          addMore = true; // 最低1人は必要
        }
      }
      eventData.attendees = attendees;

      // 開催時間の設定
      if (options.findSlot && attendees.length > 0) {
        // 空き時間を探す
        console.log(chalk.blue('Finding available time slots...'));
        
        const { duration } = await inquirer.prompt([
          {
            type: 'number',
            name: 'duration',
            message: 'Meeting duration (minutes):',
            default: 30,
            validate: (input: number) => input > 0 && input <= 480 || 'Duration must be between 1 and 480 minutes'
          }
        ]);

        // 候補を探す（14日間検索して十分な営業日をカバー）
        console.log(chalk.blue('Checking availability...'));
        const now = new Date();
        
        // Free/Busy APIのために現在時刻を30分単位に丸める（切り捨て）
        const alignedNow = new Date(now);
        alignedNow.setMinutes(Math.floor(alignedNow.getMinutes() / 30) * 30, 0, 0);
        
        const candidates: Array<{ date: Date; start: Date; end: Date }> = [];
        
        const searchDays = 14;
        const endSearchDate = addDays(alignedNow, searchDays);
        
        // カレンダーとFree/Busy情報を並行取得で高速化
        console.log(chalk.gray('Checking availability...'));
        
        const startDateStr = format(now, 'yyyy-MM-dd');
        const endDateStr = format(endSearchDate, 'yyyy-MM-dd');
        const attendeeEmails = attendees.map(a => a.emailAddress.address);
        
        console.log(chalk.gray(`Checking availability for: ${attendeeEmails.join(', ')}`));
        
        // 並行実行で高速化
        const [myEvents, freeBusyResult] = await Promise.all([
          // 自分のカレンダーを取得
          mgc.getMyCalendarEvents(
            `${startDateStr}T00:00:00+09:00`,
            `${endDateStr}T23:59:59+09:00`
          ).catch(() => {
            console.warn(chalk.yellow('Could not fetch your calendar events'));
            return [] as CalendarEvent[];
          }),
          // 参加者のFree/Busyを取得
          mgc.getUserFreeBusy(
            attendeeEmails,
            alignedNow.toISOString(),
            endSearchDate.toISOString()
          )
        ]);

        // デバッグ: Free/Busy情報を確認
        if (process.env.DEBUG) {
          console.log('\nDEBUG: API Results:');
          console.log('My events count:', myEvents.length);
          console.log('Free/Busy schedules count:', freeBusyResult.value?.length || 0);
          console.log('Search period:', format(now, 'yyyy-MM-dd HH:mm'), 'to', format(endSearchDate, 'yyyy-MM-dd HH:mm'));
          
          // 7/11の自分の予定をすべて表示
          console.log('\nDEBUG: My events on 7/11:');
          myEvents.forEach((event: CalendarEvent) => {
            const eventStart = new Date(event.start.dateTime);
            if (formatJST(eventStart, 'yyyy-MM-dd') === '2025-07-11') {
              console.log(`  "${event.subject}" ${formatJST(eventStart, 'HH:mm')} (showAs: ${event.showAs || 'not specified'})`);
            }
          });
          freeBusyResult.value?.forEach((schedule: any, index: number) => {
            console.log(`\nSchedule ${index} (${attendeeEmails[index]}):`);
            console.log('  Busy items:', schedule.scheduleItems?.length || 0);
            if (schedule.availabilityView) {
              console.log('  Availability view length:', schedule.availabilityView.length);
              console.log('  (0=Free, 1=Tentative, 2=Busy, 3=OOF, 4=WorkingElsewhere)');
              // 7/8の14:00-15:00を含む部分を表示（各文字は30分スロット）
              const startDate = new Date(now);
              const targetDate = new Date('2025-07-08T00:00:00+09:00');
              const daysDiff = Math.floor((targetDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
              if (daysDiff >= 0 && daysDiff < 14) {
                const slotsPerDay = 48; // 24時間 * 2（30分単位）
                const targetDayStart = daysDiff * slotsPerDay;
                const slot14_00 = targetDayStart + 28; // 14:00 = 28スロット目（0:00から数えて）
                const slot15_00 = targetDayStart + 30; // 15:00 = 30スロット目
                console.log(`  7/8 14:00-15:00 slots (${slot14_00}-${slot15_00}): ${schedule.availabilityView.substring(slot14_00, slot15_00 + 1)}`);
              }
            }
          });
        }

        // 各日の空き時間を探す
        for (let i = 0; i < searchDays; i++) {
          const date = addDays(now, i);
          const dateStr = format(date, 'yyyy-MM-dd');
          
          // 週末・祝日をスキップ
          if (!isWorkday(date)) {
            if (process.env.DEBUG) {
              const reason = date.getDay() === 0 || date.getDay() === 6 ? 'weekend' : 'holiday';
              console.log(`Skipping ${reason}: ${format(date, 'EEE, MMM d')}`);
            }
            continue;
          }
          
          // 営業時間の設定（JST 9:00-19:00）
          let searchStartTime = createJSTDate(dateStr, 9, 0);
          let searchEndTime = createJSTDate(dateStr, 19, 0);
          
          if (process.env.DEBUG && i === 0) {
            console.log(`\nWorking hours for ${dateStr} (JST):`);
            console.log(`  Start: ${formatJST(searchStartTime, 'yyyy-MM-dd HH:mm')} JST`);
            console.log(`  End: ${formatJST(searchEndTime, 'yyyy-MM-dd HH:mm')} JST`);
          }
          
          // 今日の場合は現在時刻の30分後から検索
          if (i === 0) {
            const minStartTime = addMinutes(now, 30);
            if (minStartTime > searchStartTime) {
              searchStartTime = minStartTime;
              if (process.env.DEBUG) {
                console.log(`  Adjusted start time (30min from now): ${formatJST(searchStartTime, 'HH:mm')} JST`);
              }
            }
          }

          // 30分単位で空き時間をチェック
          let currentTime = new Date(searchStartTime);
          while (currentTime < searchEndTime && addMinutes(currentTime, duration) <= searchEndTime) {
            const slotEnd = addMinutes(currentTime, duration);
            
            // 全員が空いているかチェック
            let allAvailable = true;
            
            if (process.env.DEBUG) {
              console.log(`\nChecking slot: ${formatJST(currentTime, 'yyyy-MM-dd HH:mm')} - ${formatJST(slotEnd, 'HH:mm')} JST`);
              console.log(`  Actual slot time: ${currentTime.toISOString()} - ${slotEnd.toISOString()}`);
            }
            
            // まず自分のカレンダーをチェック
            for (const event of myEvents) {
              // Declinedイベントはスキップ
              if (event.subject?.startsWith('Declined:')) {
                continue;
              }
              
              // イベントの時刻をそのまま使用
              const eventStart = new Date(event.start.dateTime);
              const eventEnd = new Date(event.end.dateTime);
              
              // デバッグ: 18:00スロットで自分の予定の時刻を確認
              if (process.env.DEBUG && formatJST(currentTime, 'HH:mm') === '18:00' && 
                  event.subject && !event.subject.includes('Declined')) {
                const eventDateJST = formatJST(eventStart, 'yyyy-MM-dd');
                if (eventDateJST === '2025-07-11') {
                  console.log(`  DEBUG: My event on 7/11: "${event.subject}"`);
                  console.log(`    Raw start: ${event.start.dateTime}`);
                  console.log(`    Raw end: ${event.end.dateTime}`);
                  console.log(`    Parsed time: ${formatJST(eventStart, 'HH:mm')} - ${formatJST(eventEnd, 'HH:mm')} JST`);
                  console.log(`    ShowAs: ${event.showAs || 'not specified'}`);
                }
              }
              
              // 同じ日付のイベントのみチェック（JSTで比較）
              if (!isSameDayJST(eventStart, currentTime) &&
                  !isSameDayJST(eventEnd, currentTime)) {
                continue;
              }
              
              // 終日予定のチェック（showAsがfreeでない場合のみ）
              if (event.isAllDay && isSameDayJST(eventStart, currentTime)) {
                if (event.showAs !== 'free') {
                  allAvailable = false;
                  if (process.env.DEBUG) {
                    console.log(`  ✗ Your all-day event: "${event.subject}" (${event.showAs || 'busy'})`);
                  }
                  break;
                }
              }
              
              // 時間帯の重複チェック（showAsがfreeの場合はスキップ）
              if ((currentTime >= eventStart && currentTime < eventEnd) ||
                  (slotEnd > eventStart && slotEnd <= eventEnd) ||
                  (currentTime <= eventStart && slotEnd >= eventEnd)) {
                if (event.showAs !== 'free') {
                  allAvailable = false;
                  if (process.env.DEBUG) {
                    console.log(`  ✗ Your event conflicts: "${event.subject}" (${formatJST(eventStart, 'HH:mm')}-${formatJST(eventEnd, 'HH:mm')}, ${event.showAs || 'busy'})`);
                  }
                  break;
                } else if (process.env.DEBUG) {
                  console.log(`  ○ Your event but free: "${event.subject}" (${formatJST(eventStart, 'HH:mm')}-${formatJST(eventEnd, 'HH:mm')}, free)`);
                }
              }
            }
            
            // 参加者のFree/Busyをチェック
            if (allAvailable) {
              const schedules = freeBusyResult.value || [];
              
              // availabilityViewを使ったチェック（より正確）
              for (let scheduleIndex = 0; scheduleIndex < schedules.length; scheduleIndex++) {
                const schedule = schedules[scheduleIndex];
                const attendeeEmail = attendeeEmails[scheduleIndex];
                
                // availabilityViewを使って判定
                if (schedule.availabilityView) {
                  // 現在のスロットの位置を計算
                  // availabilityViewはリクエストの開始時刻からの30分単位の配列
                  const slotStartTime = currentTime.getTime();
                  const requestStartTime = alignedNow.getTime();
                  const minutesFromStart = (slotStartTime - requestStartTime) / (1000 * 60);
                  const slotIndex = Math.floor(minutesFromStart / 30);
                  
                  if (slotIndex >= 0 && slotIndex < schedule.availabilityView.length) {
                    const availability = schedule.availabilityView.charAt(slotIndex);
                    
                    if (process.env.DEBUG && formatJST(currentTime, 'HH:mm') === '14:00') {
                      console.log(`    DEBUG: AvailabilityView for ${attendeeEmail}:`);
                      console.log(`      Slot index: ${slotIndex}, Value: ${availability}`);
                      console.log(`      Minutes from start: ${minutesFromStart}`);
                    }
                    
                    // 0=Free, 1=Tentative, 2=Busy, 3=OOF, 4=WorkingElsewhere
                    if (availability !== '0') {
                      allAvailable = false;
                      if (process.env.DEBUG) {
                        const statusMap: { [key: string]: string } = {
                          '1': 'tentative',
                          '2': 'busy', 
                          '3': 'oof',
                          '4': 'workingElsewhere'
                        };
                        console.log(`    ✗ ${attendeeEmail} is ${statusMap[availability] || 'busy'} (availabilityView)`);
                      }
                      break;
                    }
                  }
                }
              }
              
              if (schedules.length === 0) {
                console.warn(chalk.yellow('Warning: No Free/Busy data received for attendees'));
              }
              
              for (let scheduleIndex = 0; scheduleIndex < schedules.length; scheduleIndex++) {
                const schedule = schedules[scheduleIndex];
                const attendeeEmail = attendeeEmails[scheduleIndex];
                const busyTimes = schedule.scheduleItems || [];
                
                if (process.env.DEBUG) {
                  if (busyTimes.length > 0) {
                    console.log(`  Checking ${attendeeEmail}: ${busyTimes.length} busy slots`);
                  } else {
                    console.log(`  Checking ${attendeeEmail}: No busy times found`);
                  }
                }
                
                let busyOnSameDay = 0;
                let debuggedFirst = false;
                for (const busy of busyTimes) {
                  // Free/Busy APIはタイムゾーン情報なしで時間を返す
                  // 実際にはリクエストのstartTimeからの相対時間として返されている可能性がある
                  const busyStart = new Date(busy.start.dateTime);
                  const busyEnd = new Date(busy.end.dateTime);
                  
                  // デバッグ: 最初のアイテムの詳細を表示
                  if (process.env.DEBUG && !debuggedFirst) {
                    debuggedFirst = true;
                    console.log(`    DEBUG: First busy slot for ${attendeeEmail}:`);
                    console.log(`      Raw start: ${busy.start.dateTime}`);
                    console.log(`      Raw end: ${busy.end.dateTime}`);
                    
                    // 様々な解釈を試す
                    const interpretations = [
                      { tz: '', label: 'As-is (local)' },
                      { tz: '+09:00', label: 'JST' },
                      { tz: 'Z', label: 'UTC' },
                      { tz: '-08:00', label: 'PST' },
                      { tz: '-07:00', label: 'PDT' }
                    ];
                    
                    console.log(`      Interpretations:`);
                    interpretations.forEach(({ tz, label }) => {
                      const testStart = new Date(busy.start.dateTime + tz);
                      console.log(`        ${label}: ${formatJST(testStart, 'yyyy-MM-dd HH:mm')} JST`);
                    });
                    
                    // APIリクエストの開始時刻と比較
                    console.log(`      Request start time was: ${now.toISOString()}`);
                    console.log(`      Days from request start: ${Math.floor((busyStart.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))}`);
                  }
                  
                  // 開始時刻と終了時刻が同じ場合はスキップ（データの異常）
                  if (busyStart.getTime() === busyEnd.getTime()) {
                    if (process.env.DEBUG) {
                      console.log(`    - Skipping zero-duration busy slot at ${formatJST(busyStart, 'yyyy-MM-dd HH:mm')}`);
                    }
                    continue;
                  }
                  
                  // 異なる日付の場合はスキップ（高速化のため）
                  if (!isSameDayJST(busyStart, currentTime)) {
                    continue;
                  }
                  
                  // 時間帯重複チェック
                  if ((currentTime >= busyStart && currentTime < busyEnd) ||
                      (slotEnd > busyStart && slotEnd <= busyEnd) ||
                      (currentTime <= busyStart && slotEnd >= busyEnd)) {
                    allAvailable = false;
                    if (process.env.DEBUG) {
                      console.log(`    ✗ ${attendeeEmail} busy: ${formatJST(busyStart, 'HH:mm')} - ${formatJST(busyEnd, 'HH:mm')} JST`);
                    }
                    break;
                  } else if (process.env.DEBUG) {
                    // 同じ日の予定を表示
                    if (isSameDayJST(busyStart, currentTime)) {
                      // 15:00スロットの場合は全ての時間を表示
                      if (formatJST(currentTime, 'HH:mm') === '15:00' && busyOnSameDay < 10) {
                        console.log(`    - ${attendeeEmail} busy: ${formatJST(busyStart, 'yyyy-MM-dd HH:mm')} - ${formatJST(busyEnd, 'HH:mm')} JST`);
                        busyOnSameDay++;
                      }
                    }
                  }
                }
                
                if (process.env.DEBUG && busyOnSameDay === 0) {
                  console.log(`    - No busy times on ${formatJST(currentTime, 'yyyy-MM-dd')} for ${attendeeEmail}`);
                  // 14:00のスロットの場合、全てのbusy時間を確認
                  if (formatJST(currentTime, 'HH:mm') === '14:00') {
                    console.log(`    DEBUG: Checking all busy times for ${attendeeEmail}:`);
                    let count = 0;
                    for (const busyItem of busyTimes) {
                      const start = new Date(busyItem.start.dateTime + '+09:00');
                      const end = new Date(busyItem.end.dateTime + '+09:00');
                      const jstDateStr = formatJST(start, 'yyyy-MM-dd');
                      if (jstDateStr === '2025-07-08' && count < 10) {
                        console.log(`      Busy: ${formatJST(start, 'HH:mm')} - ${formatJST(end, 'HH:mm')} JST on ${jstDateStr}`);
                        count++;
                      }
                    }
                    if (count === 0) {
                      console.log(`      No busy times found for 2025-07-08`);
                    }
                  }
                }
                if (!allAvailable) break;
              }
            }
            
            if (allAvailable) {
              if (process.env.DEBUG) {
                console.log(`  ✓ Slot is available!`);
              }
              // 既にJSTで処理されているのでそのまま保存
              candidates.push({
                date: date,
                start: new Date(currentTime),
                end: new Date(slotEnd)
              });
            } else if (process.env.DEBUG) {
              console.log(`  ✗ Slot is NOT available (skipping)`);
            }
            
            // 30分進める
            currentTime = addMinutes(currentTime, 30);
          }
        }

        if (candidates.length === 0) {
          console.log(chalk.yellow(`No available time slots found in the next ${searchDays} days (weekdays only)`));
          return;
        }

        console.log(chalk.blue(`Found ${candidates.length} available time slots`));
        if (process.env.DEBUG) {
          console.log('\nDEBUG: Total candidates by day:');
          const countByDay = new Map<string, number>();
          candidates.forEach(c => {
            const day = format(c.date, 'yyyy-MM-dd (EEE)');
            countByDay.set(day, (countByDay.get(day) || 0) + 1);
          });
          countByDay.forEach((count, day) => {
            console.log(`  ${day}: ${count} slots`);
          });
          
          // 最初の5つの候補の詳細を表示
          console.log('\nDEBUG: First 5 candidates (JST):');
          candidates.slice(0, 5).forEach(c => {
            console.log(`  ${formatJST(c.start, 'yyyy-MM-dd HH:mm')} - ${formatJST(c.end, 'HH:mm')} JST`);
          });
        }

        // 候補を表示して選択（最大20個表示）
        const sortedCandidates = candidates.sort((a, b) => a.start.getTime() - b.start.getTime());
        const { selectedSlot } = await inquirer.prompt([
          {
            type: 'list',
            name: 'selectedSlot',
            message: 'Select a time slot:',
            choices: sortedCandidates.slice(0, 20).map((candidate, index) => ({
              name: `${format(candidate.date, 'EEE, MMM d')} ${formatJST(candidate.start, 'HH:mm')}-${formatJST(candidate.end, 'HH:mm')} JST`,
              value: index
            })),
            pageSize: 10,
            loop: false
          }
        ]);

        const selected = sortedCandidates[selectedSlot];
        
        eventData.start = {
          dateTime: selected.start.toISOString(),
          timeZone: 'Asia/Tokyo'
        };
        eventData.end = {
          dateTime: selected.end.toISOString(),
          timeZone: 'Asia/Tokyo'
        };
      } else {
        // 手動で時間を入力
        const { date, startTime, duration } = await inquirer.prompt([
          {
            type: 'input',
            name: 'date',
            message: 'Date (YYYY-MM-DD):',
            default: format(new Date(), 'yyyy-MM-dd'),
            validate: (input: string) => {
              const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
              return dateRegex.test(input) || 'Please enter a valid date (YYYY-MM-DD)';
            }
          },
          {
            type: 'input',
            name: 'startTime',
            message: 'Start time (HH:mm):',
            default: '10:00',
            validate: (input: string) => {
              const timeRegex = /^\d{2}:\d{2}$/;
              return timeRegex.test(input) || 'Please enter a valid time (HH:mm)';
            }
          },
          {
            type: 'number',
            name: 'duration',
            message: 'Duration (minutes):',
            default: 30
          }
        ]);

        const startDateTime = new Date(`${date}T${startTime}:00+09:00`);
        const endDateTime = addMinutes(startDateTime, duration);

        eventData.start = {
          dateTime: startDateTime.toISOString(),
          timeZone: 'Asia/Tokyo'
        };
        eventData.end = {
          dateTime: endDateTime.toISOString(),
          timeZone: 'Asia/Tokyo'
        };
      }

      // 場所の設定（オプション）
      const { hasLocation } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'hasLocation',
          message: 'Add location?',
          default: false
        }
      ]);

      if (hasLocation) {
        const { location } = await inquirer.prompt([
          {
            type: 'input',
            name: 'location',
            message: 'Location:'
          }
        ]);
        eventData.location = { displayName: location };
      }

      // イベント作成
      console.log(chalk.blue('Creating event...'));
      const eventId = await mgc.createEvent(eventData);
      
      console.log(chalk.green('✓ Event created successfully!'));
      console.log(chalk.gray(`Event ID: ${eventId}`));
    } else {
      console.log(chalk.yellow('Please use --interactive or --find-slot option'));
    }
  } catch (error: any) {
    if (error.message?.includes('ErrorAccessDenied')) {
      console.error(chalk.yellow('\n⚠️  Access denied to create calendar events'));
      console.error(chalk.gray('You may need additional permissions (Calendars.ReadWrite).'));
      console.error(chalk.gray('\nTry logging in with write permissions:'));
      console.error(chalk.cyan('npx outlook-agent login'));
    } else if (error.message?.includes('is not installed')) {
      console.error(chalk.red('\n❌ ' + error.message));
    } else {
      console.error(chalk.red('\n❌ Failed to create event:'), error.message || error);
      if (process.env.DEBUG || process.env.OUTLOOK_AGENT_DEBUG) {
        console.error(chalk.gray('\nStack trace:'));
        console.error(chalk.gray(error.stack));
      }
    }
    process.exit(1);
  }
}