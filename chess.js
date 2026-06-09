'use strict';
/* ══════════════════════════════════════════════════════════════════════
   ChessGame — Full FIDE-rules engine
   board[row][col] = {t, c} | null
   t: K Q R B N P   c: 'w' | 'b'
   row 0 = rank 8 (black back rank)   row 7 = rank 1 (white back rank)
   col 0 = file a                      col 7 = file h
══════════════════════════════════════════════════════════════════════ */
class ChessGame {
  constructor() { this.reset(); }

  reset() {
    this.board   = this._initBoard();
    this.turn    = 'w';
    this.castle  = { wK:true, wQ:true, bK:true, bQ:true };
    this.epSq    = null;          // {r,c} en-passant target square
    this.halfmove = 0;
    this.fullmove = 1;
    this.history  = [];           // {fr,fc,tr,tc,piece,san}
    this.lastMove = null;         // {fr,fc,tr,tc}
    this.status   = 'playing';    // playing|check|checkmate|stalemate|draw
    this.captured = { w:[], b:[] }; // pieces captured by each side
    this._promotionPending = null;
  }

  _initBoard() {
    const b = Array.from({length:8}, () => Array(8).fill(null));
    const back = ['R','N','B','Q','K','B','N','R'];
    for (let c=0;c<8;c++) {
      b[0][c] = {t:back[c], c:'b'};
      b[1][c] = {t:'P',     c:'b'};
      b[6][c] = {t:'P',     c:'w'};
      b[7][c] = {t:back[c], c:'w'};
    }
    return b;
  }

  p(r,c) { return (r>=0&&r<8&&c>=0&&c<8) ? this.board[r][c] : undefined; }

  /* ── Pseudo-legal move generation ── */
  _pseudo(r, c) {
    const piece = this.p(r,c);
    if (!piece) return [];
    const {t, c:col} = piece;
    const opp = col==='w'?'b':'w';
    const mv = [];

    const slide = (dr,dc) => {
      for (let nr=r+dr,nc=c+dc; nr>=0&&nr<8&&nc>=0&&nc<8; nr+=dr,nc+=dc) {
        const tp = this.p(nr,nc);
        if (tp) { if (tp.c===opp) mv.push({fr:r,fc:c,tr:nr,tc:nc}); break; }
        mv.push({fr:r,fc:c,tr:nr,tc:nc});
      }
    };

    if (t==='P') {
      const dir  = col==='w'?-1:1;
      const sRow = col==='w'?6:1;
      const pRow = col==='w'?0:7;
      const nr   = r+dir;

      if (nr>=0&&nr<8&&!this.p(nr,c)) {
        if (nr===pRow) {
          for (const pt of ['Q','R','B','N'])
            mv.push({fr:r,fc:c,tr:nr,tc:c,promo:pt});
        } else {
          mv.push({fr:r,fc:c,tr:nr,tc:c});
          if (r===sRow && !this.p(r+2*dir,c))
            mv.push({fr:r,fc:c,tr:r+2*dir,tc:c,dp:true});
        }
      }
      for (const dc of [-1,1]) {
        const nc=c+dc, cr=r+dir;
        if (nc<0||nc>7) continue;
        const tp=this.p(cr,nc);
        if (tp&&tp.c===opp) {
          if (cr===pRow) for (const pt of ['Q','R','B','N'])
            mv.push({fr:r,fc:c,tr:cr,tc:nc,promo:pt});
          else mv.push({fr:r,fc:c,tr:cr,tc:nc});
        }
        if (this.epSq&&this.epSq.r===cr&&this.epSq.c===nc)
          mv.push({fr:r,fc:c,tr:cr,tc:nc,ep:true});
      }
    }
    else if (t==='N') {
      for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const nr=r+dr,nc=c+dc;
        if (nr<0||nr>7||nc<0||nc>7) continue;
        const tp=this.p(nr,nc);
        if (!tp||tp.c===opp) mv.push({fr:r,fc:c,tr:nr,tc:nc});
      }
    }
    else if (t==='B') { slide(-1,-1);slide(-1,1);slide(1,-1);slide(1,1); }
    else if (t==='R') { slide(-1,0);slide(1,0);slide(0,-1);slide(0,1); }
    else if (t==='Q') {
      slide(-1,-1);slide(-1,1);slide(1,-1);slide(1,1);
      slide(-1,0);slide(1,0);slide(0,-1);slide(0,1);
    }
    else if (t==='K') {
      for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
        const nr=r+dr,nc=c+dc;
        if (nr<0||nr>7||nc<0||nc>7) continue;
        const tp=this.p(nr,nc);
        if (!tp||tp.c===opp) mv.push({fr:r,fc:c,tr:nr,tc:nc});
      }
      const back=col==='w'?7:0;
      if (r===back&&c===4) {
        const ck=col==='w'?this.castle.wK:this.castle.bK;
        const cq=col==='w'?this.castle.wQ:this.castle.bQ;
        if (ck&&!this.p(back,5)&&!this.p(back,6))
          mv.push({fr:r,fc:c,tr:back,tc:6,castle:'K'});
        if (cq&&!this.p(back,3)&&!this.p(back,2)&&!this.p(back,1))
          mv.push({fr:r,fc:c,tr:back,tc:2,castle:'Q'});
      }
    }
    return mv;
  }

  /* ── Attack detection ── */
  _attacked(r,c,byCol) {
    for (let ar=0;ar<8;ar++) for (let ac=0;ac<8;ac++) {
      const p=this.board[ar][ac];
      if (!p||p.c!==byCol) continue;
      const mvs=this._pseudo(ar,ac);
      if (mvs.some(m=>m.tr===r&&m.tc===c&&!m.castle)) return true;
    }
    return false;
  }

  _findKing(col) {
    for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
      const p=this.board[r][c];
      if (p&&p.t==='K'&&p.c===col) return {r,c};
    }
    return null;
  }

  inCheck(col=this.turn) {
    const k=this._findKing(col);
    return k ? this._attacked(k.r,k.c,col==='w'?'b':'w') : false;
  }

  /* ── Apply / Undo (for legality testing) ── */
  _apply(mv) {
    const {fr,fc,tr,tc,promo,ep,castle} = mv;
    const moving   = this.board[fr][fc];
    const captured = this.board[tr][tc];
    this.board[tr][tc] = promo ? {t:promo,c:moving.c} : {...moving};
    this.board[fr][fc] = null;
    let epCap=null, epPos=null;
    if (ep) {
      epPos={r:fr,c:tc};
      epCap=this.board[fr][tc];
      this.board[fr][tc]=null;
    }
    let rookSnap=null;
    if (castle) {
      const back=moving.c==='w'?7:0;
      if (castle==='K') {
        rookSnap={fromC:7,toC:5,piece:this.board[back][7],r:back};
        this.board[back][5]=this.board[back][7];
        this.board[back][7]=null;
      } else {
        rookSnap={fromC:0,toC:3,piece:this.board[back][0],r:back};
        this.board[back][3]=this.board[back][0];
        this.board[back][0]=null;
      }
    }
    return {fr,fc,tr,tc,moving,captured,epCap,epPos,rookSnap};
  }

  _undo(snap) {
    const {fr,fc,tr,tc,moving,captured,epCap,epPos,rookSnap}=snap;
    this.board[fr][fc]=moving;
    this.board[tr][tc]=captured;
    if (epPos) this.board[epPos.r][epPos.c]=epCap;
    if (rookSnap) {
      this.board[rookSnap.r][rookSnap.fromC]=rookSnap.piece;
      this.board[rookSnap.r][rookSnap.toC]=null;
    }
  }

  /* ── Legal moves for piece at (r,c) ── */
  legalMoves(r,c) {
    const piece=this.board[r][c];
    if (!piece||piece.c!==this.turn) return [];
    const opp=piece.c==='w'?'b':'w';
    const legal=[];

    for (const mv of this._pseudo(r,c)) {
      if (mv.castle) {
        if (this.inCheck(piece.c)) continue;
        const back=piece.c==='w'?7:0;
        const passCol=mv.castle==='K'?5:3;
        if (this._attacked(back,passCol,opp)) continue;
      }
      const snap=this._apply(mv);
      const inChk=this.inCheck(piece.c);
      this._undo(snap);
      if (!inChk) legal.push(mv);
    }
    return legal;
  }

  _anyLegal(col) {
    const saved=this.turn;
    this.turn=col;
    for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
      const p=this.board[r][c];
      if (p&&p.c===col&&this.legalMoves(r,c).length>0) {
        this.turn=saved; return true;
      }
    }
    this.turn=saved; return false;
  }

  /* ── Execute a move ── */
  // Returns: 'ok'|'check'|'checkmate'|'stalemate'|'draw'|'promotion'|'illegal'
  move(fr,fc,tr,tc,promoChoice=null) {
    const legal=this.legalMoves(fr,fc);
    const cands=legal.filter(m=>m.tr===tr&&m.tc===tc);
    if (!cands.length) return 'illegal';

    if (cands.some(m=>m.promo)) {
      if (!promoChoice) return 'promotion';
      const mv=cands.find(m=>m.promo===promoChoice);
      if (!mv) return 'illegal';
      return this._exec(mv);
    }
    return this._exec(cands[0]);
  }

  _exec(mv) {
    const {fr,fc,tr,tc}=mv;
    const moving=this.board[fr][fc];
    const captured=this.board[tr][tc];

    this._apply(mv);
    this.lastMove={fr,fc,tr,tc,castle:mv.castle,promo:mv.promo,ep:mv.ep};

    // Track captures
    if (captured) this.captured[moving.c].push(captured);
    if (mv.ep)    this.captured[moving.c].push({t:'P',c:this.turn==='w'?'b':'w'});

    // Update castling rights
    if (moving.t==='K') {
      if (moving.c==='w') {this.castle.wK=false;this.castle.wQ=false;}
      else                {this.castle.bK=false;this.castle.bQ=false;}
    }
    if (moving.t==='R'||captured?.t==='R') {
      if (fr===7&&fc===7||tr===7&&tc===7) this.castle.wK=false;
      if (fr===7&&fc===0||tr===7&&tc===0) this.castle.wQ=false;
      if (fr===0&&fc===7||tr===0&&tc===7) this.castle.bK=false;
      if (fr===0&&fc===0||tr===0&&tc===0) this.castle.bQ=false;
    }

    // En-passant square
    this.epSq = mv.dp ? {r:(fr+tr)/2,c:fc} : null;

    // Halfmove clock
    this.halfmove = (moving.t==='P'||captured) ? 0 : this.halfmove+1;

    // Switch turn
    this.turn = this.turn==='w'?'b':'w';
    if (this.turn==='w') this.fullmove++;

    // 50-move draw
    if (this.halfmove>=100) { this.status='draw'; return 'draw'; }

    // Status
    const oppInChk = this.inCheck(this.turn);
    const hasLegal = this._anyLegal(this.turn);
    this.status = !hasLegal
      ? (oppInChk?'checkmate':'stalemate')
      : (oppInChk?'check':'playing');

    this.history.push({fr,fc,tr,tc,piece:moving,status:this.status});
    return this.status==='playing'?'ok':this.status;
  }

  /* ── Helpers ── */
  pieceVal(t) { return {P:1,N:3,B:3,R:5,Q:9,K:0}[t]||0; }
  pieceName(t){ return {K:'King',Q:'Queen',R:'Rook',B:'Bishop',N:'Knight',P:'Pawn'}[t]||t; }
  colorName(c){ return c==='w'?'White':'Black'; }
  squareName(r,c){ return 'abcdefgh'[c]+(8-r); }
}
