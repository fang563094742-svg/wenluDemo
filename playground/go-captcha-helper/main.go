package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/wenlng/go-captcha-assets/resources/imagesv2"
	"github.com/wenlng/go-captcha-assets/resources/tiles"
	"github.com/wenlng/go-captcha/v2/slide"
)

var slideCapt slide.Captcha

type slideOutput struct {
	ImageBase64 string `json:"image_base64"`
	TileBase64  string `json:"tile_base64"`
	TileWidth   int    `json:"tile_width"`
	TileHeight  int    `json:"tile_height"`
	TileX       int    `json:"tile_x"`
	TileY       int    `json:"tile_y"`
	TargetX     int    `json:"target_x"`
	TargetY     int    `json:"target_y"`
}

func init() {
	builder := slide.NewBuilder()

	imgs, err := imagesv2.GetImages()
	if err != nil {
		log.Fatalln(err)
	}

	graphs, err := tiles.GetTiles()
	if err != nil {
		log.Fatalln(err)
	}

	newGraphs := make([]*slide.GraphImage, 0, len(graphs))
	for _, graph := range graphs {
		newGraphs = append(newGraphs, &slide.GraphImage{
			OverlayImage: graph.OverlayImage,
			MaskImage:    graph.MaskImage,
			ShadowImage:  graph.ShadowImage,
		})
	}

	builder.SetResources(
		slide.WithGraphImages(newGraphs),
		slide.WithBackgrounds(imgs),
	)

	slideCapt = builder.Make()
}

func generateSlide() error {
	captData, err := slideCapt.Generate()
	if err != nil {
		return err
	}

	block := captData.GetData()
	if block == nil {
		return fmt.Errorf("generate captcha block failed")
	}

	master, err := captData.GetMasterImage().ToBase64()
	if err != nil {
		return err
	}

	tile, err := captData.GetTileImage().ToBase64()
	if err != nil {
		return err
	}

	out := slideOutput{
		ImageBase64: master,
		TileBase64:  tile,
		TileWidth:   block.Width,
		TileHeight:  block.Height,
		TileX:       block.DX,
		TileY:       block.DY,
		TargetX:     block.X,
		TargetY:     block.Y,
	}

	return json.NewEncoder(os.Stdout).Encode(out)
}

func main() {
	cmd := "generate-slide"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "generate-slide":
		if err := generateSlide(); err != nil {
			log.Fatalln(err)
		}
	default:
		log.Fatalf("unsupported command: %s", cmd)
	}
}
