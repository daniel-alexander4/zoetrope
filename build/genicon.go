//go:build ignore

// genicon writes a 256x256 PNG of a colored ball on a dark background.
// Run: go run build/genicon.go > web/icon.png
package main

import (
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
)

func main() {
	const size = 256
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	bg := color.NRGBA{R: 14, G: 14, B: 22, A: 255}
	ballOuter := color.NRGBA{R: 245, G: 194, B: 231, A: 255} // pink
	ballInner := color.NRGBA{R: 137, G: 180, B: 250, A: 255} // blue

	cx, cy := float64(size)/2, float64(size)/2
	rOuter := float64(size) * 0.36
	rInner := rOuter * 0.55

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := float64(x) - cx
			dy := float64(y) - cy
			d := math.Sqrt(dx*dx + dy*dy)
			var c color.NRGBA
			switch {
			case d <= rInner:
				c = ballInner
			case d <= rOuter:
				t := (d - rInner) / (rOuter - rInner)
				c = lerp(ballInner, ballOuter, t)
			default:
				c = bg
			}
			img.SetRGBA(x, y, color.RGBA{c.R, c.G, c.B, c.A})
		}
	}
	if err := png.Encode(os.Stdout, img); err != nil {
		panic(err)
	}
}

func lerp(a, b color.NRGBA, t float64) color.NRGBA {
	return color.NRGBA{
		R: uint8(float64(a.R)*(1-t) + float64(b.R)*t),
		G: uint8(float64(a.G)*(1-t) + float64(b.G)*t),
		B: uint8(float64(a.B)*(1-t) + float64(b.B)*t),
		A: 255,
	}
}
