"""Render illustrative motion comparisons; this is not Android app code."""
from pathlib import Path
import math
import subprocess
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
W, H, FPS, SECONDS = 1120, 760, 60, 12
BG = '#0D0F12'
SURFACE = '#15161B'
CARD = '#23252B'
ACCENT = '#FF814A'
WHITE = '#F4F1EF'
MUTED = '#ADAEB7'
FONT = '/System/Library/Fonts/SFNS.ttf'
FONTS = {size: ImageFont.truetype(FONT, size) for size in [14, 16, 18, 20, 22, 26, 30, 34, 38]}


def text(d, xy, value, size=20, color=WHITE, anchor=None):
    d.text(xy, value, font=FONTS[size], fill=color, anchor=anchor)


def rr(d, box, fill=CARD, radius=18, outline=None, width=1):
    d.rounded_rectangle(tuple(map(round, box)), radius=radius, fill=fill, outline=outline, width=width)


def clamp(x):
    return max(0.0, min(1.0, x))


def ease(x):
    x = clamp(x)
    return 1 - (1-x)**3


def spring(x):
    if x <= 0:
        return 0
    if x >= 1:
        return 1
    return 1 - math.exp(-6*x) * (math.cos(11*x) + 6/11*math.sin(11*x))


def star(d, center, radius, fill, outline=ACCENT):
    cx, cy = center
    pts = []
    for i in range(10):
        a = -math.pi/2 + math.pi*i/5
        r = radius if i % 2 == 0 else radius*.45
        pts.append((cx+math.cos(a)*r, cy+math.sin(a)*r))
    d.polygon(pts, fill=fill, outline=outline, width=2)


def wave(d, box, t, expressive=False):
    x0, y0, x1, y1 = box
    ratio = 3
    layer = Image.new('RGBA', (round((x1-x0)*ratio), round((y1-y0)*ratio)))
    ld = ImageDraw.Draw(layer)
    phase = t * 2*math.pi / (4 if expressive else 12)
    amp = (y1-y0) * (.31 if expressive else .18)
    for j in range(10):
        pts=[]
        for k in range(181):
            u = k/180
            envelope = .65+.35*math.sin(math.pi*u)
            v = math.sin(u*math.pi*2.1-phase+j*.085)
            v += .24*math.sin(u*math.pi*4+phase*.7+j*.10)
            pts.append((u*(x1-x0)*ratio, ((y1-y0)/2+amp*envelope*v+(j-4.5)*2.9)*ratio))
        f = .38+.062*j
        color=tuple(round(c*f) for c in (255,129,74))
        ld.line(pts, fill=color+(255,), width=ratio)
    layer = layer.resize((round(x1-x0), round(y1-y0)), Image.Resampling.LANCZOS)
    d._image.paste(layer, (round(x0), round(y0)), layer)


def button(d, box, label, scale=1.0, orange=True):
    x0,y0,x1,y1=box
    cx,cy=(x0+x1)/2,(y0+y1)/2
    hw,hh=(x1-x0)*scale/2,(y1-y0)*scale/2
    rr(d,(cx-hw,cy-hh,cx+hw,cy+hh),ACCENT if orange else '#292C33',14)
    text(d,(cx,cy),label,20,'#19191B' if orange else WHITE,'mm')


def base(title, subtitle):
    im=Image.new('RGB',(W,H),BG)
    d=ImageDraw.Draw(im)
    text(d,(34,23),title,30)
    text(d,(34,67),subtitle,18,MUTED)
    for i,x in enumerate([32,580]):
        text(d,(x+8,111),'A  Smooth · recommended' if i==0 else 'B  Expressive',22,ACCENT if i==0 else WHITE)
        rr(d,(x,150,x+508,685),SURFACE,28,'#353840')
    text(d,(34,718),'MusicMute  /  Motion study · 60 fps · Illustrative, not a device recording',16,MUTED)
    return im


def caption(d,x,label):
    text(d,(x+254,654),label,18,MUTED,'mm')


def tap(d,center,dt):
    if 0 <= dt < .42:
        r=8+dt*42
        g=round(220*(1-dt/.42)+30)
        d.ellipse((center[0]-r,center[1]-r,center[0]+r,center[1]+r),outline=(g,g,g),width=2)


def waves(t):
    im=base('01  Flowing waves','Same artwork. Compare the pace and amount of movement.')
    d=ImageDraw.Draw(im)
    for i,x in enumerate([32,580]):
        text(d,(x+30,181),'MusicMute',22)
        text(d,(x+30,237),'Good to',38)
        text(d,(x+30,284),'hear you.',38,ACCENT)
        wave(d,(x+4,329,x+504,460),t,bool(i))
        rr(d,(x+24,476,x+484,613))
        text(d,(x+46,495),'Sign in',26)
        button(d,(x+46,543,x+462,593),'Sign in')
        caption(d,x,'Slow flow · small movement' if i==0 else 'Faster flow · larger movement')
    return im


def sheets(t):
    im=base('02  Bottom sheets','Watch the sheet open, settle and close. Both start at the same time.')
    d=ImageDraw.Draw(im)
    p=t%6
    for i,x in enumerate([32,580]):
        text(d,(x+30,180),'MusicMute',22)
        text(d,(x+30,226),'Processing jobs',30)
        wave(d,(x+20,260,x+488,341),t)
        button(d,(x+28,350,x+480,406),'Import audio')
        for j,label in enumerate(['Interview.mp3','Lecture.m4a']):
            rr(d,(x+28,427+j*77,x+480,489+j*77))
            text(d,(x+45,445+j*77),label,20)
        duration=.34 if i==0 else .75
        if p<.8: amount=0
        elif p<3.75: amount=(ease if i==0 else spring)((p-.8)/duration)
        else: amount=1-ease((p-3.75)/.3)
        tap(d,(x+254,378),p-.8)
        overlay=Image.new('RGBA',(508,475),(0,0,0,0))
        od=ImageDraw.Draw(overlay)
        od.rectangle((0,0,508,475),fill=(0,0,0,round(125*clamp(amount))))
        if amount>0:
            top=475-320*amount
            rr(od,(8,top,500,520),'#272930',26)
            rr(od,(224,top+12,284,top+17),'#777981',3)
            text(od,(32,top+40),'Review audio',26)
            text(od,(32,top+85),'Interview.mp3',22)
            text(od,(32,top+120),'03:24  ·  8.2 MB',18,MUTED)
            text(od,(32,top+160),'Ready to review before processing.',18,MUTED)
            button(od,(32,top+206,476,top+260),'Continue')
            text(od,(254,top+287),'Cancel',18,MUTED,'mm')
        im.paste(overlay,(x,150),overlay)
        d=ImageDraw.Draw(im)
        caption(d,x,'Gentle easing · no overshoot' if i==0 else 'Spring opening · visible overshoot')
    return im


def touch(t):
    im=base('03  Button presses & stars','White rings mark simulated taps. Compare how much the controls react.')
    d=ImageDraw.Draw(im)
    p=t%6
    for i,x in enumerate([32,580]):
        text(d,(x+30,181),'Your library.',30)
        wave(d,(x+20,222,x+488,300),t)
        dt=p-1.0
        scale=1
        if 0<=dt<.12: scale=1-(.025 if i==0 else .09)*ease(dt/.12)
        elif .12<=dt<.8:
            scale=(.975 if i==0 else .91)+( .025 if i==0 else .09)*(ease((dt-.12)/.18) if i==0 else spring((dt-.12)/.65))
        button(d,(x+30,325,x+478,385),'Play audio',scale)
        if 0<=dt<.48:
            ripple=Image.new('RGBA',(448,60),(0,0,0,0))
            rd=ImageDraw.Draw(ripple)
            r=dt*650
            rd.ellipse((224-r,30-r,224+r,30+r),fill=(255,255,255,round(75*(1-dt/.48))))
            mask=Image.new('L',(448,60),0)
            ImageDraw.Draw(mask).rounded_rectangle((0,0,448,60),radius=14,fill=255)
            ripple.putalpha(Image.composite(ripple.getchannel('A'),Image.new('L',(448,60)),mask))
            im.paste(ripple,(x+30,325),ripple)
            d=ImageDraw.Draw(im)
        tap(d,(x+254,355),dt)
        rr(d,(x+30,421,x+478,543))
        text(d,(x+52,448),'Interview.mp3',22)
        text(d,(x+52,484),'Voice output · 03:24',18,MUTED)
        dt2=p-3.0
        ss=1
        if 0<=dt2<.7:
            ss=1+(.12 if i==0 else .38)*math.sin(min(1,dt2/(.3 if i==0 else .7))*math.pi)*math.exp(-dt2*(3 if i==0 else 1))
        star(d,(x+427,481),20*ss,ACCENT if dt2>=0 else CARD,ACCENT if dt2>=0 else MUTED)
        tap(d,(x+427,481),dt2)
        caption(d,x,'Small press · ripple · gentle star' if i==0 else 'Deeper press · stronger star bounce')
    return im


def page_content(player):
    im=Image.new('RGBA',(464,400),SURFACE)
    d=ImageDraw.Draw(im)
    if not player:
        text(d,(8,10),'Your library.',30)
        rr(d,(8,65,456,115))
        text(d,(26,80),'Search your media',18,MUTED)
        for j,name in enumerate(['Interview.mp3','Lecture.m4a']):
            rr(d,(8,139+j*100,456,222+j*100))
            text(d,(28,154+j*100),name,22)
            text(d,(28,188+j*100),'Voice output',18,MUTED)
            d.polygon([(410,165+j*100),(410,193+j*100),(432,179+j*100)],fill=ACCENT)
    else:
        text(d,(8,10),'Now playing',26)
        rr(d,(8,61,456,268))
        wave(d,(20,76,444,175),0)
        text(d,(28,187),'Interview.mp3',26)
        text(d,(28,227),'Voice output · 03:24',18,MUTED)
        rr(d,(20,294,444,298),'#44464F',2)
        rr(d,(20,294,178,298),ACCENT,2)
        d.ellipse((200,322,264,386),fill=ACCENT)
        d.rectangle((220,343,227,365),fill=BG)
        d.rectangle((237,343,244,365),fill=BG)
    return im


PAGES=[page_content(False),page_content(True)]


def navigation(t):
    im=base('04  Opening the player','A track opens the player, then returns to the library. Compare the transition.')
    d=ImageDraw.Draw(im)
    p=t%6
    for i,x in enumerate([32,580]):
        text(d,(x+28,180),'MusicMute',22)
        going=p<3.5
        start=1.0 if going else 3.5
        progress=(ease if i==0 else spring)((p-start)/(.23 if i==0 else .65))
        before=0 if going else 1
        after=1-before
        canvas=Image.new('RGBA',(464,400),SURFACE)
        old=PAGES[before].copy()
        old.putalpha(round(255*(1-clamp(progress))))
        canvas.alpha_composite(old)
        if p>=start:
            new=PAGES[after].copy()
            new.putalpha(round(255*clamp(progress)))
            shift=round((1-progress)*(20 if i==0 else 170)*(1 if going else -1))
            canvas.alpha_composite(new,(shift,0))
        im.paste(canvas,(x+22,224),canvas)
        d=ImageDraw.Draw(im)
        if going: tap(d,(x+22+420,224+180),p-1)
        caption(d,x,'Short fade + small slide' if i==0 else 'Longer spring + large slide')
    return im


def render(name, frame_func):
    dest=OUT/(name+'.mp4')
    cmd=['/opt/homebrew/bin/ffmpeg','-y','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(dest)]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    for frame in range(FPS*SECONDS):
        im=frame_func(frame/FPS)
        proc.stdin.write(im.convert('RGB').tobytes())
        if frame==int(FPS*2): im.save(OUT/(name+'-poster.png'))
    proc.stdin.close()
    if proc.wait()!=0: raise RuntimeError(f'ffmpeg failed: {name}')
    print(f'Rendered {dest.name}',flush=True)


if __name__=='__main__':
    for name,func in [('01-waves',waves),('02-bottom-sheets',sheets),('03-buttons-stars',touch),('04-navigation',navigation)]:
        render(name,func)
