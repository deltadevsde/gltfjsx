const THREE = require('three')
const isVarName = require('./isVarName')

function parse(fileName, gltf, options = {}) {
  const url = (fileName.toLowerCase().startsWith('http') ? '' : '/') + fileName
  const animations = gltf.animations
  const hasAnimations = animations.length > 0

  // Collect all objects
  const objects = []
  gltf.scene.traverse((child) => objects.push(child))

  // Browse for duplicates
  const duplicates = {
    names: {},
    materials: {},
    geometries: {},
  }

  function uniqueName(attempt, index = 0) {
    const newAttempt = index > 0 ? attempt + index : attempt
    if (Object.values(duplicates.geometries).find(({ name }) => name === newAttempt) === undefined) return newAttempt
    else return uniqueName(attempt, index + 1)
  }

  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      if (child.material) {
        if (!duplicates.materials[child.material.name]) {
          duplicates.materials[child.material.name] = 1
        } else {
          duplicates.materials[child.material.name]++
        }
      }
      if (child.geometry) {
        if (!duplicates.geometries[child.geometry.uuid]) {
          let name = (child.name || 'Part').replace(/[^a-zA-Z]/g, '')
          name = name.charAt(0).toUpperCase() + name.slice(1)
          duplicates.geometries[child.geometry.uuid] = {
            count: 1,
            name: uniqueName(name),
            node: 'nodes' + sanitizeName(child.name),
          }
        } else {
          duplicates.geometries[child.geometry.uuid].count++
        }
      }
    }
  })

  // Prune duplicate geometries
  if (!options.instanceall) {
    for (let key of Object.keys(duplicates.geometries)) {
      const duplicate = duplicates.geometries[key]
      if (duplicate.count === 1) delete duplicates.geometries[key]
    }
  }

  const hasInstances = (options.instance || options.instanceall) && Object.keys(duplicates.geometries).length > 0

  function sanitizeName(name) {
    return isVarName(name) ? `.${name}` : `['${name}']`
  }

  const rNbr = (number) => {
    return parseFloat(number.toFixed(Math.round(options.precision || 2)))
  }

  const rDeg = (number) => {
    const abs = Math.abs(Math.round(parseFloat(number) * 100000))
    for (let i = 1; i <= 10; i++) {
      if (abs === Math.round(parseFloat(Math.PI / i) * 100000))
        return `${number < 0 ? '-' : ''}Math.PI${i > 1 ? ' / ' + i : ''}`
    }
    for (let i = 1; i <= 10; i++) {
      if (abs === Math.round(parseFloat(Math.PI * i) * 100000))
        return `${number < 0 ? '-' : ''}Math.PI${i > 1 ? ' * ' + i : ''}`
    }
    return rNbr(number)
  }

  function printTypes(objects, animations) {
    let meshes = objects.filter((o) => o.isMesh && o.__removed === undefined)
    let bones = objects.filter((o) => o.isBone && !(o.parent && o.parent.isBone) && o.__removed === undefined)
    let materials = [...new Set(objects.filter((o) => o.material && o.material.name).map((o) => o.material))]

    let animationTypes = ''
    if (animations.length) {
      animationTypes = `\n
  type ActionName = ${animations.map((clip, i) => `"${clip.name}"`).join(' | ')};`
    }

    return `\ntype GLTFResult = GLTF & {
    nodes: {
      ${meshes.map(({ name, type }) => (isVarName(name) ? name : `['${name}']`) + ': THREE.' + type).join(',')}
      ${bones.map(({ name, type }) => (isVarName(name) ? name : `['${name}']`) + ': THREE.' + type).join(',')}
    }
    materials: {
      ${materials.map(({ name, type }) => (isVarName(name) ? name : `['${name}']`) + ': THREE.' + type).join(',')}
    }
  }\n${animationTypes}`
  }

  function print(objects, gltf, obj, parent) {
    let result = ''
    let children = ''
    let type = obj.type.charAt(0).toLowerCase() + obj.type.slice(1)
    let node = 'nodes' + sanitizeName(obj.name)
    let isCamera = type === 'perspectiveCamera' || type === 'orthographicCamera'
    let isInstanced =
      (options.instance || options.instanceall) &&
      obj.geometry &&
      duplicates.geometries[obj.geometry.uuid] &&
      duplicates.geometries[obj.geometry.uuid].count > (options.instanceall ? 0 : 1)
    let hasAnimations = gltf.animations && gltf.animations.length > 0

    if (options.setLog)
      setTimeout(
        () => options.setLog((state) => [...state, obj.name]),
        (options.timeout = options.timeout + options.delay)
      )

    // Turn object3d's into groups, it should be faster according to the threejs docs
    if (type === 'object3D') type = 'group'
    if (type === 'perspectiveCamera') type = 'PerspectiveCamera'
    if (type === 'orthographicCamera') type = 'OrthographicCamera'

    // Bail out on lights and bones
    if (type === 'bone') {
      return `<primitive object={${node}} />${!parent ? '' : '\n'}`
    }

    // Collect children
    if (obj.children) obj.children.forEach((child) => (children += print(objects, gltf, child, obj)))

    if (isInstanced) {
      result = `<instances.${duplicates.geometries[obj.geometry.uuid].name} `
    } else {
      // Form the object in JSX syntax
      result = `<${type} `
    }

    // Include names when output is uncompressed or morphTargetDictionaries are present
    if (
      obj.name.length &&
      (options.keepnames ||
        obj.morphTargetDictionary ||
        (hasAnimations &&
          gltf.animations.find(
            (clip) => clip.name.includes(obj.name) || (clip.targetNames && clip.targetNames.includes(obj.name))
          )))
    )
      result += `name="${obj.name}" `

    const oldResult = result

    // Handle cameras
    if (isCamera) {
      result += `makeDefault={false} `
      if (obj.zoom !== 1) result += `zoom={${rNbr(obj.zoom)}} `
      if (obj.far !== 2000) result += `far={${rNbr(obj.far)}} `
      if (obj.near !== 0.1) result += `near={${rNbr(obj.near)}} `
    }
    if (type === 'PerspectiveCamera') {
      if (obj.fov !== 50) result += `fov={${rNbr(obj.fov)}} `
    }

    if (!isInstanced) {
      // Shadows
      if (type === 'mesh' && options.shadows) result += `castShadow receiveShadow `

      // Write out geometry first
      if (obj.geometry) {
        result += `geometry={${node}.geometry} `
      }

      // Write out materials
      if (obj.material) {
        if (obj.material.name && duplicates.materials[obj.material.name] === 1)
          result += `material={materials${sanitizeName(obj.material.name)}} `
        else result += `material={${node}.material} `
      }

      if (obj.skeleton) result += `skeleton={${node}.skeleton} `
      if (obj.visible === false) result += `visible={false} `
      if (obj.castShadow === true) result += `castShadow `
      if (obj.receiveShadow === true) result += `receiveShadow `
      if (obj.morphTargetDictionary) result += `morphTargetDictionary={${node}.morphTargetDictionary} `
      if (obj.morphTargetInfluences) result += `morphTargetInfluences={${node}.morphTargetInfluences} `
      if (obj.intensity && rNbr(obj.intensity)) result += `intensity={${rNbr(obj.intensity)}} `
      //if (obj.power && obj.power !== 4 * Math.PI) result += `power={${rNbr(obj.power)}} `
      if (obj.angle && obj.angle !== Math.PI / 3) result += `angle={${rDeg(obj.angle)}} `
      if (obj.penumbra && rNbr(obj.penumbra) !== 0) result += `penumbra={${rNbr(obj.penumbra)}} `
      if (obj.decay && rNbr(obj.decay) !== 1) result += `decay={${rNbr(obj.decay)}} `
      if (obj.distance && rNbr(obj.distance) !== 0) result += `distance={${rNbr(obj.distance)}} `
      if (obj.up && obj.up.isVector3 && !obj.up.equals(new THREE.Vector3(0, 1, 0)))
        result += `up={[${rNbr(obj.up.x)}, ${rNbr(obj.up.y)}, ${rNbr(obj.up.z)},]} `
    }

    const hasPosition = obj.position && obj.position.isVector3 && rNbr(obj.position.length())
    const hasRotation = obj.rotation && obj.rotation.isEuler && rNbr(obj.rotation.toVector3().length())
    const hasScale =
      obj.scale &&
      obj.scale.isVector3 &&
      !(rNbr(obj.scale.x) === 1 && rNbr(obj.scale.y) === 1 && rNbr(obj.scale.z) === 1)

    if (obj.color && obj.color.getHexString() !== 'ffffff') result += `color="#${obj.color.getHexString()}" `
    if (hasPosition) result += `position={model_position} `
    if (hasRotation) result += `rotation={model_rotation} `
    if (hasScale) {
      result += `scale={model_scale}`
    }
    if (options.meta && obj.userData && Object.keys(obj.userData).length)
      result += `userData={${JSON.stringify(obj.userData)}} `

    // Remove empty groups
    if (
      !options.keepgroups &&
      (type === 'group' || type === 'scene') &&
      (result === oldResult || obj.children.length === 0)
    ) {
      obj.__removed = true
      return children
    }

    // Close tag
    result += `${children.length ? '>' : '/>'}\n`

    // Add children and return
    if (children.length) result += children + `</${type}>${!parent ? '' : '\n'}`

    return result
  }

  function printControls(objects, obj) {
    let materials = [...new Set(objects.filter((o) => o.material && o.material.name).map((o) => o.material))]
    let materialControls = materials.map((mat, i) => {
      let hasClearCoat = mat.hasOwnProperty('clearcoat')
      let hasClearCoatRoughness = mat.hasOwnProperty('clearcoatRoughness')
      return `
        const { model_color${i}, metalness${i}, roughness${i}${hasClearCoat ? ', clearcoat' + i : ``}${
        hasClearCoatRoughness ? ', clearcoatRoughness' + i : ``
      }} = useControls('${mat.name}', \{
          metalness${i}: {
            value: context.ctx_metalness${i},
            min: -1,
            max: 1,
            step: 0.1,
          },
          roughness${i}: {
            value: context.ctx_roughness${i},
            min: -1,
            max: 1,
            step: 0.1,
          },
          ${
            hasClearCoat
              ? `clearcoat${i}: {
            value: context.ctx_clearcoat${i},
            min: -1,
            max: 1,
            step: 0.1,
          },`
              : ``
          } 
          ${
            hasClearCoatRoughness
              ? `clearcoatRoughness${i}: {
            value: context.ctx_clearcoatRoughness${i},
            min: -1,
            max: 1,
            step: 0.1,
          },`
              : ``
          }
          model_color${i}: context.ctx_model_color${i}
        \}\);\n`
    })

    return `

    const {
      model_position,
      model_rotation,
      model_scale
    } = useControls('Model', {
      model_position: context.ctx_model_position,
      model_rotation:  context.ctx_model_rotation,
      model_scale: context.ctx_model_scale
      })
    
    ${materialControls.join('')}
    

    const { pointLight1Intensity, pointLight1Decay, pointLight1Pos } =
      useControls('PointLight1', {
        pointLight1Intensity: {
          value: context.ctx_pointLight1Intensity,
          min: -2,
          max: 2,
          step: 1,
        },
        pointLight1Decay: {
          value: context.ctx_pointLight1Decay,
          min: -2,
          max: 2,
          step: 1,
        },
        pointLight1Pos: {
          value: {
            x: context.ctx_pointLight1Pos.x,
            y: context.ctx_pointLight1Pos.y,
            z: context.ctx_pointLight1Pos.z
          },
          x: {
            min: -15,
            max: 15,
            step: 1,
          },
          y: {
            min: -15,
            max: 15,
            step: 1,
          },
          z: {
            min: -15,
            max: 15,
            step: 1,
          },
        },
      });
  
    const { pointLight2Intensity, pointLight2Decay, pointLight2Pos } =
      useControls('PointLight2', {
        pointLight2Intensity: {
          value: context.ctx_pointLight2Intensity,
          min: -2,
          max: 2,
          step: 1,
        },
        pointLight2Decay: {
          value: context.ctx_pointLight2Decay,
          min: -2,
          max: 2,
          step: 1,
        },
        pointLight2Pos: {
          value: {
            x: context.ctx_pointLight2Pos.x,
            y: context.ctx_pointLight2Pos.y,
            z: context.ctx_pointLight2Pos.z,
          },
          x: {
            min: -15,
            max: 15,
            step: 1,
          },
          y: {
            min: -15,
            max: 15,
            step: 1,
          },
          z: {
            min: -15,
            max: 15,
            step: 1,
          },
        },
      });
  
    const { spotLightIntensity, spotLightDecay, spotLightPos } = useControls(
      'Spot Light',
      {
        spotLightIntensity: {
          value: context.ctx_spotLightIntensity,
          min: -1,
          max: 1,
          step: 0.1,
        },
        spotLightDecay: {
          value: context.ctx_spotLightDecay,
          min: -1,
          max: 1,
          step: 0.1,
        },
        spotLightPos: {
          value: {
            x: context.ctx_spotLightPos.x,
            y: context.ctx_spotLightPos.y,
            z: context.ctx_spotLightPos.z,
          },
          x: {
            min: -15,
            max: 15,
            step: 1,
          },
          y: {
            min: -15,
            max: 15,
            step: 1,
          },
          z: {
            min: -15,
            max: 15,
            step: 1,
          },
        },
      }
    );

    useFrame(() => {
      ${materials.map((mat, i) => {
        const hasClearCoat = mat.hasOwnProperty('clearcoat')
        const hasClearCoatRoughness = mat.hasOwnProperty('clearcoatRoughness')
        return `
        materials${sanitizeName(mat.name)}.metalness = metalness${i};
        materials${sanitizeName(mat.name)}.roughness = roughness${i};
        ${hasClearCoat ? `materials${sanitizeName(mat.name)}.clearcoat = clearcoat${i};` : ''}
        ${
          hasClearCoatRoughness ? `materials${sanitizeName(mat.name)}.clearcoatRoughness = clearcoatRoughness${i};` : ''
        }
        materials${sanitizeName(mat.name)}.color = new THREE.Color(
          \`rgb(\${model_color${i}.r}, \${model_color${i}.g}, \${model_color${i}.b})\`)
        `
      })}      
    });
  
    
    `
  }

  function listVariableControlNames(objects, obj) {
    let controls = printControls(objects, obj)
    return controls
      .match(new RegExp(/(?<=\{).+?(?=\})/g))
      .filter((str) => !str.includes('r: ') && !str.includes('.r') && !str.includes('.g') && !str.includes('.b'))
      .flatMap((str) => str.replaceAll(/\s/g, '').split(','))
  }

  function intializeVariableState(objects, obj) {
    let materials = [...new Set(objects.filter((o) => o.material && o.material.name).map((o) => o.material))]
    return materials.map((mat, i) => {
      let hasClearCoat = mat.hasOwnProperty('clearcoat')
      let hasClearCoatRoughness = mat.hasOwnProperty('clearcoatRoughness')
      return `
        ctx_metalness${i}: -1,
        ctx_roughness${i}: 1,
        ${hasClearCoat ? `ctx_clearcoat${i}: 0,` : ``} 
        ${hasClearCoatRoughness ? `ctx_clearcoatRoughness${i}: 0,` : ``}
        ctx_model_color${i}: { r: 255, b: 255, g: 255 }
        `
    })
  }

  function printAnimations(animations) {
    return animations.length ? `\nconst { actions } = useAnimations(animations, group)` : ''
  }

  function parseExtras(extras) {
    if (extras) {
      return (
        Object.keys(extras)
          .map((key) => `${key}: ${extras[key]}`)
          .join('\n') + '\n'
      )
    } else return ''
  }

  function p(obj, line) {
    console.log(
      [...new Array(line * 2)].map(() => ' ').join(''),
      obj.type,
      obj.name,
      'pos:',
      obj.position.toArray().map(rNbr),
      'scale:',
      obj.scale.toArray().map(rNbr),
      'rot:',
      [obj.rotation.x, obj.rotation.y, obj.rotation.z].map(rNbr),
      'mat:',
      obj.material ? `${obj.material.name}-${obj.material.uuid.substring(0, 8)}` : ''
    )
    obj.children.forEach((o) => p(o, line + 1))
  }

  if (options.debug) p(gltf.scene, 0)

  const scene = print(objects, gltf, gltf.scene)
  const controls = printControls(objects, gltf.scene)
  let variableControlNames = listVariableControlNames(objects, gltf.scene)
  /*  let effect = `
    useEffect(() => \{
    ${variableControlNames.map((variableName) => "context['" + variableName + "'] = " + variableName + ';').join('')}
  \})` */
  const contextVariables = intializeVariableState(objects, gltf.scene)

  return `
        ${options.types ? `\nimport * as THREE from 'three'` : ''}
        import React, { Suspense, useState, useCallback, useContext, useEffect, useRef ${
          hasInstances ? ', useMemo' : ''
        } } from 'react'
        import { folder, Leva, useControls } from 'leva';
        import { useGLTF, Cloud, OrbitControls, Stars, ${hasInstances ? 'Merged, ' : ''} ${
    scene.includes('PerspectiveCamera') ? 'PerspectiveCamera,' : ''
  }
        ${scene.includes('OrthographicCamera') ? 'OrthographicCamera,' : ''}
        ${hasAnimations ? 'useAnimations' : ''} } from '@react-three/drei'
        ${options.types ? 'import { GLTF } from "three-stdlib"' : ''}
        import { Canvas, useFrame } from '@react-three/fiber';
        ${options.types ? printTypes(objects, animations) : ''}

        const componentToHex = (c: number) => {
          const hex = c.toString(16);
          return hex.length == 1 ? '0' + hex : hex;
        };
        
        const rgbToHex = (r: number, g: number, b: number) => {
          return '#' + componentToHex(r) + componentToHex(g) + componentToHex(b);
        };

        function download(content: BlobPart, fileName: string, contentType: string) {
          var a = document.createElement('a');
          var file = new Blob([content], { type: contentType });
          a.href = URL.createObjectURL(file);
          a.download = fileName;
          a.click();
        }

        ${
          hasInstances
            ? `
        function InstancedModel(props) {
          const { nodes } = useGLTF('${url}'${options.draco ? `, ${JSON.stringify(options.draco)}` : ''})${
                options.types ? ' as GLTFResult' : ''
              }
          const instances = useMemo(() => ({
            ${Object.values(duplicates.geometries)
              .map((v) => `${v.name}: ${v.node}`)
              .join(', ')}
          }), [nodes])
          return (
            <Merged meshes={instances} {...props}>
              {(instances) => <Model instances={instances} />}
            </Merged>
          )
        }
        `
            : ''
        }

        const PropContext = React.createContext<any>({
            ${contextVariables.map((i) => i).join(',')},
            ctx_model_position: [${rNbr(gltf.scene.position.x)}, ${rNbr(gltf.scene.position.y)}, ${rNbr(
    gltf.scene.position.z
  )}],
        ctx_model_rotation: [${rDeg(gltf.scene.rotation.x)}, ${rDeg(gltf.scene.rotation.y)}, ${rDeg(
    gltf.scene.rotation.z
  )}],
        ctx_model_scale: ${
          gltf.scene.scale.x === gltf.scene.scale.y && gltf.scene.scale.x === gltf.scene.scale.z
            ? rNbr(gltf.scene.scale.x)
            : [rDeg(gltf.scene.rotation.x), rDeg(gltf.scene.rotation.y), rDeg(gltf.scene.rotation.z)]
        },
            ctx_pointLight1Intensity: 0,
            ctx_pointLight1Decay: 0,
            ctx_pointLight1Pos: { x: 0, y: 2, z: 1.5 },
            ctx_pointLight2Intensity: 0,
            ctx_pointLight2Decay: 0,
            ctx_pointLight2Pos: { x: 0, y: 2, z: 1.5 },
            ctx_spotLightIntensity: 0,
            ctx_spotLightDecay: 0,
            ctx_spotLightPos: { x: 0, y: 2, z: 1.5 },
            ctx_backgroundGradient: true,
            ctx_color1: { r: 2, g: 132, b: 199 },
            ctx_color2: { r: 125, g: 211, b: 252 },
            ctx_positionSpotLight: [3, 10, 3],
            ctx_angleSpotLight: 0.5,
            ctx_penumbraSpotLight: 1,
            ctx_intensitySpotLight: 0.2,
            ctx_positionPointLightOne: [10, 7, 10],
            ctx_intensityPointLightOne: 0.2,
            ctx_positionPointLightTwo: [5, 0.5, 5],
            ctx_intensityPointLightTwo: 1,
            ctx_positionCloudOne: [3, 10, 3],
            ctx_opacityCloudOne: 0.2,
            ctx_rotationSpeedCloudOne: 0.4,
            ctx_widthCloudOne: 1,
            ctx_depthCloudOne: 1.5,
            ctx_segmentsCloudOne: 2,
            ctx_positionCloudTwo: [-8, 8, -6],
            ctx_opacityCloudTwo: 0.2,
            ctx_rotationSpeedCloudTwo: 0.4,
            ctx_widthCloudTwo: 1,
            ctx_depthCloudTwo: 1.5,
            ctx_segmentsCloudTwo: 1,
            ctx_positionCloudThree: [-3, 15, -3],
            ctx_opacityCloudThree: 0.2,
            ctx_rotationSpeedCloudThree: 0.4,
            ctx_widthCloudThree: 2,
            ctx_depthCloudThree: 1,
            ctx_segmentsCloudThree: 6,
            ctx_radiusStars: 100,
            ctx_depthStars: 25,
            ctx_countStars: 5000,
            ctx_factorStars: 4,
            ctx_saturationStars: 1,
            ctx_fadeStars: true
        });

        function Model({ ${hasInstances ? 'instances, ' : ''}...props }${
    options.types ? ": JSX.IntrinsicElements['group']" : ''
  }) {
                const group = ${options.types ? 'useRef<THREE.Group>()' : 'useRef()'}
                const { nodes, materials${hasAnimations ? ', animations' : ''} } = useGLTF('${url}'${
    options.draco ? `, ${JSON.stringify(options.draco)}` : ''
  })${options.types ? ' as GLTFResult' : ''}${printAnimations(animations)}
  let context = useContext(PropContext);

  
  ${controls}
  

  
        return (
                <group ref={group} {...props} dispose={null}>
                  ${scene}
                  <pointLight
                    intensity={pointLight1Intensity}
                    decay={pointLight1Decay}
                    position={[pointLight1Pos.x, pointLight1Pos.y, pointLight1Pos.z]}
                    rotation={[-Math.PI, -Math.PI, -Math.PI]}
                  />
                  <pointLight
                    intensity={pointLight2Intensity}
                    decay={pointLight2Decay}
                    position={[pointLight2Pos.x, pointLight2Pos.y, pointLight2Pos.z]}
                    rotation={[-Math.PI, -Math.PI, -Math.PI]}
                  />
                  <spotLight
                    intensity={spotLightIntensity}
                    angle={Math.PI / 10}
                    decay={spotLightDecay}
                    position={[spotLightPos.x, spotLightPos.y, spotLightPos.z]}
                    rotation={[0, -Math.PI, 0]}
                  />
                </group>
        )}

        
useGLTF.preload('${url}')


       export default function CombinedModel() {

       let context = useContext(PropContext);

       const [files, setFiles] = useState('');

  const handleChange = (e: any) => {
    const fileReader = new FileReader();
    fileReader.readAsText(e.target.files[0], 'UTF-8');
    fileReader.onload = (e) => {
      setFiles(e.target!.result as string);
    };
  };

  useEffect(() => {
    if (files) {
      context = { ...JSON.parse(files) };
    }
  }, [files]);
 

  const {
    backgroundGradient,
    color1,
    color2,
    positionCloudOne,
    opacityCloudOne,
    rotationSpeedCloudOne,
    widthCloudOne,
    depthCloudOne,
    segmentsCloudOne,
    positionCloudTwo,
    opacityCloudTwo,
    rotationSpeedCloudTwo,
    widthCloudTwo,
    depthCloudTwo,
    segmentsCloudTwo,
    positionCloudThree,
    opacityCloudThree,
    rotationSpeedCloudThree,
    widthCloudThree,
    depthCloudThree,
    segmentsCloudThree,
    positionSpotLight,
    angleSpotLight,
    penumbraSpotLight,
    intensitySpotLight,
    positionPointLightOne,
    intensityPointLightOne,
    positionPointLightTwo,
    intensityPointLightTwo,
    radiusStars,
    depthStars,
    countStars,
    factorStars,
    saturationStars,
    fadeStars,
  } = useControls('Background', {
    General: folder({
      backgroundGradient: context.ctx_backgroundGradient,
      color1: context.ctx_color1,
      color2: context.ctx_color2,
    }),
    SpotLight: folder({
      positionSpotLight: context.ctx_positionSpotLight,
      angleSpotLight: {
        value: context.ctx_angleSpotLight,
        min: 0,
        max: 1,
        step: 0.1,
      },
      penumbraSpotLight: {
        value: context.ctx_penumbraSpotLight,
        min: 0,
        max: 5,
        step: 0.1,
      },
      intensitySpotLight: {
        value: context.ctx_intensitySpotLight,
        min: 0,
        max: 3,
        step: 0.1,
      },
    }),
    PointLight1: folder({
      positionPointLightOne: context.ctx_positionPointLightOne,

      intensityPointLightOne: {
        value: context.ctx_intensityPointLightOne,
        min: 0,
        max: 3,
        step: 0.1,
      },
    }),
    PointLight2: folder({
      positionPointLightTwo: context.ctx_positionPointLightTwo,

      intensityPointLightTwo: {
        value: context.ctx_intensityPointLightTwo,
        min: 0,
        max: 3,
        step: 0.1,
      },
    }),
    Cloud1: folder({
      positionCloudOne: context.ctx_positionCloudOne,
      opacityCloudOne: {
        value: context.ctx_positionCloudOne,
        min: 0,
        max: 1,
        step: 0.1,
      },
      rotationSpeedCloudOne: {
        value: context.ctx_rotationSpeedCloudOne,
        min: 0,
        max: 1,
        step: 0.1,
      },
      widthCloudOne: {
        value: context.ctx_widthCloudOne,
        min: 0,
        max: 10,
        step: 0.1,
      },
      depthCloudOne: {
        value: context.ctx_depthCloudOne,
        min: 0,
        max: 10,
        step: 0.1,
      },
      segmentsCloudOne: {
        value: context.ctx_segmentsCloudOne,
        min: 0,
        max: 15,
        step: 1,
      },
    }),
    Cloud2: folder({
      positionCloudTwo: context.ctx_positionCloudTwo,
      opacityCloudTwo: {
        value: context.ctx_opacityCloudTwo,
        min: 0,
        max: 1,
        step: 0.1,
      },
      rotationSpeedCloudTwo: {
        value: context.ctx_rotationSpeedCloudTwo,
        min: 0,
        max: 1,
        step: 0.1,
      },
      widthCloudTwo: {
        value: context.ctx_widthCloudTwo,
        min: 0,
        max: 10,
        step: 0.1,
      },
      depthCloudTwo: {
        value: context.ctx_depthCloudTwo,
        min: 0,
        max: 10,
        step: 0.1,
      },
      segmentsCloudTwo: {
        value: context.ctx_segmentsCloudTwo,
        min: 0,
        max: 15,
        step: 1,
      },
    }),
    Cloud3: folder({
      positionCloudThree: context.ctx_positionCloudThree,
      opacityCloudThree: {
        value: context.ctx_opacityCloudThree,
        min: 0,
        max: 1,
        step: 0.1,
      },
      rotationSpeedCloudThree: {
        value: context.ctx_rotationSpeedCloudThree,
        min: 0,
        max: 1,
        step: 0.1,
      },
      widthCloudThree: {
        value: context.ctx_widthCloudThree,
        min: 0,
        max: 10,
        step: 0.1,
      },
      depthCloudThree: {
        value: context.ctx_depthCloudThree,
        min: 0,
        max: 10,
        step: 0.1,
      },
      segmentsCloudThree: {
        value: context.ctx_segmentsCloudThree,
        min: 0,
        max: 15,
        step: 1,
      },
    }),
    Stars: folder({
      radiusStars: {
        value: context.ctx_radiusStars,
        min: 0,
        max: 300,
        step: 10,
      },
      depthStars: {
        value: context.ctx_depthStars,
        min: 0,
        max: 100,
        step: 5,
      },
      countStars: {
        value: context.ctx_countStars,
        min: 0,
        max: 10000,
        step: 100,
      },
      factorStars: {
        value: context.ctx_factorStars,
        min: 0,
        max: 15,
        step: 1,
      },
      saturationStars: {
        value: context.ctx_saturationStars,
        min: 0,
        max: 1,
        step: 0.1,
      },
      fadeStars: context.ctx_fadeStars,
    }),
  });

  useEffect(() => {
    context.ctx_backgroundGradient =backgroundGradient;
    context.ctx_color1 =    color1;
    context.ctx_color2 =    color2;
    context.ctx_positionCloudOne =    positionCloudOne;
    context.ctx_opacityCloudOne =    opacityCloudOne;
    context.ctx_rotationSpeedCloudOne =    rotationSpeedCloudOne;
    context.ctx_widthCloudOne =    widthCloudOne;
    context.ctx_depthCloudOne =    depthCloudOne;
    context.ctx_segmentsCloudOne =    segmentsCloudOne;
    context.ctx_positionCloudTwo =    positionCloudTwo;
    context.ctx_opacityCloudTwo =    opacityCloudTwo;
    context.ctx_rotationSpeedCloudTwo =    rotationSpeedCloudTwo;
    context.ctx_widthCloudTwo =    widthCloudTwo;
    context.ctx_depthCloudTwo =    depthCloudTwo;
    context.ctx_segmentsCloudTwo =    segmentsCloudTwo;
    context.ctx_positionCloudThree =    positionCloudThree;
    context.ctx_opacityCloudThree =    opacityCloudThree;
    context.ctx_rotationSpeedCloudThree =    rotationSpeedCloudThree;
    context.ctx_widthCloudThree =    widthCloudThree;
    context.ctx_depthCloudThree =    depthCloudThree;
    context.ctx_segmentsCloudThree =    segmentsCloudThree;
    context.ctx_positionSpotLight =    positionSpotLight;
    context.ctx_angleSpotLight =    angleSpotLight;
    context.ctx_penumbraSpotLight =    penumbraSpotLight;
    context.ctx_intensitySpotLight =    intensitySpotLight;
    context.ctx_positionPointLightOne =    positionPointLightOne;
    context.ctx_intensityPointLightOne =    intensityPointLightOne;
    context.ctx_positionPointLightTwo =    positionPointLightTwo;
    context.ctx_intensityPointLightTwo =    intensityPointLightTwo;
    context.ctx_radiusStars =    radiusStars;
    context.ctx_depthStars =    depthStars;
    context.ctx_countStars =    countStars;
    context.ctx_factorStars =    factorStars;
    context.ctx_saturationStars =    saturationStars;
    context.ctx_fadeStars =    fadeStars;
  })

          return (
            
            <div
            className={"h-screen items-center justify-center absolute inset-0 overflow-x-hidden z-0 min-h-screen"}
            style={{
              background:\`\${
                backgroundGradient
                  ? \`linear-gradient(to left, \${rgbToHex(color1.r, color1.g, color1.b)}, \${rgbToHex(
                      color2.r,
                      color2.g,
                      color2.b
                      )})\`
                  : rgbToHex(color1.r, color1.g, color1.b)
              }\`,
            }}
          >
            <Leva flat oneLineLabels />
      
            <Canvas className='h-full w-full' camera={{ position: [1, 2.5, 8] }}>
              <spotLight
                position={positionSpotLight}
                angle={angleSpotLight}
                penumbra={penumbraSpotLight}
                intensity={intensitySpotLight}
              />
              <pointLight
                position={positionPointLightOne}
                intensity={intensityPointLightOne}
              />
              <Suspense fallback={null}>
                {/* <Environment preset='forest' /> */}
                <ambientLight intensity={0.3} />
                <Stars
                  radius={radiusStars}
                  depth={depthStars}
                  count={countStars}
                  factor={factorStars}
                  saturation={saturationStars}
                  fade={fadeStars}
                />
                <group position={positionCloudOne}>
                  <Cloud
                    opacity={opacityCloudOne}
                    speed={rotationSpeedCloudOne} 
                    width={widthCloudOne} 
                    depth={depthCloudOne} 
                    segments={segmentsCloudOne} 
                  />
                </group>
                <group position={positionCloudTwo}>
                  <Cloud
                    opacity={opacityCloudTwo}
                    speed={rotationSpeedCloudTwo} 
                    width={widthCloudTwo} 
                    depth={depthCloudTwo} 
                    segments={segmentsCloudTwo} 
                  />
                </group>
                <group position={positionCloudThree}>
                  <Cloud
                    opacity={opacityCloudThree}
                    speed={rotationSpeedCloudThree} 
                    width={widthCloudThree} 
                    depth={depthCloudThree} 
                    segments={segmentsCloudThree} 
                  />
                </group>
                <pointLight
                  position={positionPointLightTwo}
                  intensity={intensityPointLightTwo}
                />
                <OrbitControls makeDefault enableZoom={false} />
                <Model />
              </Suspense>
            </Canvas>
            <div className='absolute bottom-0 flex justify-center w-full'>
              <button
                className='absolute bg-black bottom-2 px-2 py-16 rounded-full text-white text-xl w-3/12'
                onClick={() =>
                  download(JSON.stringify(context), 'pixelmon.json', 'text/json')
                }
              >
                save
              </button>
            </div>
            <div className='absolute bottom-0 left-0'>
              <input type='file' onChange={handleChange} />
            </div>
          </div>
          )
        }
`
}

module.exports = parse
