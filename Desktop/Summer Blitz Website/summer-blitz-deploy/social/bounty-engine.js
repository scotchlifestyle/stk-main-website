
// Pure selectors for the app's confirmed RSVP / game-roster adapter.
// Dates must be ISO timestamps with an explicit UTC offset. IDs are canonical,
// not names. Supply one current attendance record per game/player, including
// cancellations. Membership or a home venue never implies attendance.
window.STKBounty = (() => {
 function nextGame({games, now=new Date().toISOString(), seriesId}) {
  const instant=Date.parse(now);
  if(!Number.isFinite(instant))throw new Error('A valid reference time is required');
  return games.filter(g=>g.status==='scheduled'&&(!seriesId||g.series_id===seriesId)&&Date.parse(g.starts_at)>instant)
   .sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at)||a.id.localeCompare(b.id))[0]||null;
 }
 function board({games, results, attendance, now, seriesId, hostIds=[],seedCandidatesByVenue={}}) {
  const game=nextGame({games,now,seriesId});
  if(!game)return {game:null,players:[],rosterKnown:false};
  const eligible=new Map();
  for(const w of results){
   if(!w.player_id||w.voided||!Number.isFinite(Date.parse(w.won_at))||Date.parse(w.won_at)>=Date.parse(game.starts_at))continue;
   eligible.set(w.player_id,{player_id:w.player_id,name:w.player_name});
  }
  const current=new Map();
  for(const a of attendance.filter(a=>a.game_id===game.id)) {
   if(!a.player_id)continue;
   const previous=current.get(a.player_id);
   if(!previous||Date.parse(a.updated_at)>=Date.parse(previous.updated_at))current.set(a.player_id,a);
  }
  const players=[];
  for(const a of current.values()){
   if(!['confirmed','checked_in'].includes(a.status))continue;
   if(!eligible.has(a.player_id)&&!hostIds.includes(a.player_id))continue;
   players.push({player_id:a.player_id,name:eligible.get(a.player_id)?.name||a.player_name,attendance:a.status});
  }
  const hasAttendees=Array.from(current.values()).some(a=>['confirmed','checked_in'].includes(a.status));
  // A real roster with only non-winners stays empty: never insert seed players
  // among confirmed attendees. Seed selection is venue-scoped and ID-based.
  if(!hasAttendees){
   const seeded=new Map();
   for(const id of seedCandidatesByVenue[game.venue_id]||[]){
    if(eligible.has(id)&&!seeded.has(id))seeded.set(id,{...eligible.get(id),attendance:'seeded'});
    if(seeded.size===3)break;
   }
   if(seeded.size)return {game,players:Array.from(seeded.values()),rosterKnown:false,mode:'seeded'};
  }
  return {game,players:players.sort((a,b)=>a.name.localeCompare(b.name)),rosterKnown:game.roster_loaded===true||current.size>0,mode:'confirmed'};
 }
 return {nextGame,board};
})();
